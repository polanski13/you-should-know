import { randomUUID } from "node:crypto"
import { comparable, digest, prepareContext, redact, topicKey } from "./context.js"
import type { ObserverConfig } from "./config.js"
import { makePrompt, modelResponseSchema, observerInstructions } from "./prompt.js"
import { prune } from "./store.js"
import type { SessionState, State, StateStore } from "./store.js"
import { observationSchema, responseSchema } from "./types.js"
import type {
  ContextMessage,
  Feedback,
  Finding,
  ModelProvider,
  Note,
  Observation,
  ObservationResult,
} from "./types.js"

function sessionFor(
  state: State,
  input: Pick<Observation, "sessionId" | "turnId">,
  now: number,
): SessionState {
  const key = digest(input.sessionId)
  let session = state.sessions[key]
  if (!session) {
    session = {
      turnId: input.turnId,
      touchedAt: now,
      checks: 0,
      lastCheckAt: 0,
      revision: "",
      ignored: 0,
      skip: 0,
    }
    state.sessions[key] = session
  }
  if (session.turnId !== input.turnId) {
    const note = state.notes.find((item) => item.id === session.noteId && item.status === "unread")
    if (note) {
      note.status = "expired"
      session.ignored++
      session.skip = session.ignored <= 2 ? 0 : Math.min(16, 2 ** (session.ignored - 3))
    }
    session.turnId = input.turnId
    session.noteId = undefined
    session.lease = undefined
  }
  session.touchedAt = now
  return session
}

function grounded(finding: Finding, messages: ContextMessage[]): boolean {
  return (
    finding.evidence.every((evidence) => {
      const message = messages.find((item) => item.id === evidence.messageId)
      return message !== undefined && message.text.includes(evidence.quote)
    }) && redact(JSON.stringify(finding)) === JSON.stringify(finding)
  )
}

export class Observer {
  private readonly running = new Map<string, { turnId: string; controller: AbortController }>()
  private readonly turns = new Map<string, string>()
  private closed = false

  constructor(
    readonly store: StateStore,
    readonly config: ObserverConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async beginTurn(sessionId: string, turnId: string): Promise<void> {
    this.turns.set(sessionId, turnId)
    const current = this.running.get(sessionId)
    if (current && current.turnId !== turnId) current.controller.abort()
    await this.store.transact((state) => {
      sessionFor(state, { sessionId, turnId }, this.now())
    })
  }

  async invalidate(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.controller.abort()
    await this.store.transact((state) => {
      const session = state.sessions[digest(sessionId)]
      if (session) session.lease = undefined
    })
  }

  async notifications(sessionId: string): Promise<Note[]> {
    return this.store.transact((state) => {
      prune(state, this.now(), this.config.retentionDays)
      const notes = state.notes
        .filter(
          (note) =>
            note.sessionId === sessionId &&
            note.status === "unread" &&
            note.deliveredAt === undefined,
        )
        .slice(-1)
      for (const note of notes) note.deliveredAt = this.now()
      return notes
    })
  }

  async observe(
    raw: Observation,
    provider: ModelProvider,
    manual = false,
  ): Promise<ObservationResult> {
    if (this.closed) return { status: "skipped", reason: "disposed" }
    const input = observationSchema.parse(raw)
    this.turns.set(input.sessionId, input.turnId)
    const current = this.running.get(input.sessionId)
    if (current && current.turnId !== input.turnId) current.controller.abort()
    const messages = prepareContext(input.messages, this.config)
    if (messages.length < 2) {
      await this.beginTurn(input.sessionId, input.turnId)
      return { status: "skipped", reason: "insufficient_context" }
    }
    const revision = digest(JSON.stringify(messages))
    const lease = randomUUID()
    const reservation = await this.store.transact((state) => {
      const now = this.now()
      prune(state, now, this.config.retentionDays)
      const session = sessionFor(state, input, now)
      const skip = (reason: string) => ({ status: "skipped", reason }) as const
      if (!this.config.enabled || state.paused) return skip("paused")
      if (session.lease && session.lease.until > now) return skip("in_flight")
      if (session.offeredTurn === input.turnId) return skip("already_offered")
      if (session.revision === revision) return skip("unchanged")
      if (
        session.checks >= this.config.maxChecksPerSession ||
        state.checks.length >= this.config.maxChecksPerHour
      )
        return skip("budget")
      if (!manual && (input.step < this.config.minSteps || input.step % this.config.minSteps !== 0))
        return skip("cadence")
      if (!manual && session.checks > 0 && now - session.lastCheckAt < this.config.minIntervalMs)
        return skip("cooldown")
      if (!manual && session.skip > 0) {
        session.skip--
        return skip("backoff")
      }
      session.lease = { id: lease, until: now + this.config.timeoutMs + 5_000 }
      session.revision = revision
      session.lastCheckAt = now
      session.checks++
      state.checks.push(now)
      return {
        status: "reserved",
        known: state.known.map((item) => item.topic),
        recent: state.notes.slice(-30).map(({ topic, summary }) => ({ topic, summary })),
      } as const
    })
    if (reservation.status === "skipped") return reservation
    if (this.closed || this.turns.get(input.sessionId) !== input.turnId) {
      await this.store.transact((state) => {
        const session = state.sessions[digest(input.sessionId)]
        if (session?.lease?.id === lease) session.lease = undefined
      })
      return { status: "skipped", reason: "stale" }
    }

    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.timeoutMs)])
    this.running.set(input.sessionId, { turnId: input.turnId, controller })
    let outcome: ObservationResult
    let finding: Finding | null = null
    try {
      const request = provider.complete({
        system: observerInstructions,
        prompt: makePrompt({
          messages,
          known: reservation.known,
          recent: reservation.recent,
          language: this.config.language,
        }),
        schema: modelResponseSchema,
        signal,
        maxOutputTokens: 1_200,
      })
      const response = await abortable(request, signal)
      if (response.text.length > 32_000) throw new InvalidResponse()
      const parsed = responseSchema.safeParse(parseResponse(response.text))
      if (!parsed.success) throw new InvalidResponse()
      finding = parsed.data.note
      outcome =
        finding === null
          ? { status: "quiet", reason: "no_finding" }
          : finding.confidence < this.config.minConfidence
            ? { status: "quiet", reason: "low_confidence" }
            : !grounded(finding, messages)
              ? { status: "quiet", reason: "unsubstantiated" }
              : { status: "quiet", reason: "no_finding" }
    } catch (error) {
      outcome = {
        status: "error",
        reason: signal.aborted
          ? controller.signal.aborted
            ? "cancelled"
            : "timeout"
          : error instanceof InvalidResponse || error instanceof SyntaxError
            ? "invalid_response"
            : "provider_error",
      }
    } finally {
      if (this.running.get(input.sessionId)?.controller === controller)
        this.running.delete(input.sessionId)
    }
    return this.store.transact((state) => {
      const session = state.sessions[digest(input.sessionId)]
      if (session?.lease?.id !== lease || session.turnId !== input.turnId)
        return { status: "skipped", reason: "stale" }
      session.lease = undefined
      if (controller.signal.aborted) return { status: "skipped", reason: "stale" }
      if (state.paused) return { status: "skipped", reason: "paused" }
      if (!finding || outcome.status !== "quiet" || outcome.reason !== "no_finding") return outcome
      const key = topicKey(finding.topic)
      if (
        !key ||
        state.known.some((item) => topicKey(item.topic) === key) ||
        state.notes.some(
          (note) =>
            topicKey(note.topic) === key ||
            comparable(note.summary) === comparable(finding!.summary),
        )
      )
        return { status: "quiet", reason: "duplicate" }
      const note: Note = {
        ...finding,
        id: randomUUID(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        host: input.host,
        createdAt: this.now(),
        status: "unread",
      }
      state.notes.push(note)
      state.notes = state.notes.slice(-100)
      session.noteId = note.id
      session.offeredTurn = input.turnId
      return { status: "shown", note }
    })
  }

  async notes(sessionId?: string): Promise<Note[]> {
    return this.store.transact((state) => {
      prune(state, this.now(), this.config.retentionDays)
      return state.notes.filter((note) => !sessionId || note.sessionId === sessionId).toReversed()
    })
  }

  async feedback(id: string, feedback: Feedback): Promise<Note> {
    return this.store.transact((state) => {
      prune(state, this.now(), this.config.retentionDays)
      const note = state.notes.find((item) => item.id === id)
      if (!note) throw new Error("Note not found in this project")
      note.status = feedback
      const session = state.sessions[digest(note.sessionId)]
      if (session) {
        session.ignored = 0
        session.skip = 0
        if (session.noteId === id) session.noteId = undefined
      }
      if (feedback === "known" || feedback === "helpful") {
        const key = topicKey(note.topic)
        state.known = state.known.filter((item) => topicKey(item.topic) !== key)
        state.known.push({ topic: note.topic, at: this.now() })
        state.known = state.known.slice(-100)
      }
      return note
    })
  }

  async pause(paused: boolean): Promise<void> {
    if (paused) for (const item of this.running.values()) item.controller.abort()
    await this.store.transact((state) => {
      state.paused = paused
    })
  }

  dispose(): void {
    this.closed = true
    for (const item of this.running.values()) item.controller.abort()
    this.running.clear()
    this.turns.clear()
  }
}

class InvalidResponse extends Error {}

function parseResponse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")
  return JSON.parse(trimmed) as unknown
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
