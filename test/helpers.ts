import { emptyState } from "../src/core/store.js"
import type { State, StateStore } from "../src/core/store.js"
import { observerConfigSchema } from "../src/core/config.js"
import type { Finding, ModelProvider, ModelRequest, Observation } from "../src/core/types.js"

export class MemoryStore implements StateStore {
  state = emptyState()
  private queue: Promise<unknown> = Promise.resolve()
  transact<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(() => fn(this.state))
    this.queue = next.catch(() => undefined)
    return next
  }
}

export const config = observerConfigSchema.parse({ minIntervalMs: 0, maxChecksPerHour: 100 })
export const observation: Observation = {
  host: "cli",
  sessionId: "session-1",
  turnId: "turn-1",
  step: 6,
  messages: [
    {
      id: "user-1",
      role: "user",
      text: "Keep the monthly bill below $100 while adding follow-up questions.",
    },
    {
      id: "agent-1",
      role: "assistant",
      text: "I enabled caching. Every first request costs 25% more; repeat requests are cheaper. Most users currently ask only one question.",
    },
  ],
}
export const finding: Finding = {
  kind: "heads_up",
  topic: "Caching costs for one-off questions",
  confidence: 0.96,
  summary: "Caching raises the cost for people who ask only one question.",
  explanation:
    "The first request costs 25% more, and most users currently ask only one question. That can work against your $100 monthly budget. Check how often people actually follow up before enabling caching for everyone.",
  evidence: [{ messageId: "agent-1", quote: "Every first request costs 25% more" }],
}

export function provider(
  value: Finding | null = finding,
  inspect?: (request: ModelRequest) => void,
): ModelProvider {
  return {
    name: "fixture",
    complete: async (request) => {
      inspect?.(request)
      return { text: JSON.stringify({ note: value }) }
    },
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
