import type { Plugin } from "@opencode/plugin"
import { normalizeMessages } from "../adapters/messages.js"
import { dataDirectory, loadConfig, observerOverrides } from "../core/config.js"
import { digest } from "../core/context.js"
import { Observer } from "../core/observer.js"
import { FileStore } from "../core/store.js"
import { YouShouldKnow } from "./rpc.js"

export default {
  id: "you-should-know",
  async setup(ctx) {
    const config = await loadConfig({ workspace: ctx.location.directory })
    const options = observerOverrides(ctx.options)
    const observer = new Observer(await FileStore.create(dataDirectory(), ctx.location.directory), {
      ...config.observer,
      ...options,
    })
    const turns = new Map<string, { id: string; step: number }>()
    const roots = new Map<string, Promise<boolean>>()
    const jobs = new Set<Promise<unknown>>()
    const lifetime = new AbortController()
    let disposed = false
    const rpc = await ctx.rpc.register(YouShouldKnow, {
      notes: ({ sessionId }) => observer.notes(sessionId),
      feedback: async ({ id, feedback }) => {
        const note = await observer.feedback(id, feedback)
        await rpc.events.emit("changed", { sessionId: note.sessionId })
        return note
      },
      pause: async ({ paused }) => {
        await observer.pause(paused)
        return paused
      },
    })

    const launch = (job: Promise<unknown>) => {
      jobs.add(job)
      void job.catch(() => undefined).finally(() => jobs.delete(job))
    }

    await ctx.session.hook("prompt", (event) => {
      turns.set(event.sessionID, { id: event.messageID, step: 0 })
      launch(
        observer.beginTurn(event.sessionID, event.messageID).then(async () => {
          if (!disposed) await rpc.events.emit("changed", { sessionId: event.sessionID })
        }),
      )
    })
    await ctx.session.hook("context", (event) => {
      if (disposed) return
      const messages = normalizeMessages(event.messages)
      const latestUser = messages.findLast((message) => message.role === "user")
      if (!latestUser) return
      const turn = turns.get(event.sessionID) ?? { id: digest(latestUser.text), step: 0 }
      turn.step++
      turns.set(event.sessionID, turn)
      if (!roots.has(event.sessionID)) {
        roots.set(
          event.sessionID,
          ctx.session
            .get({ sessionID: event.sessionID }, { signal: lifetime.signal })
            .then((session) => !session.parentID)
            .catch(() => false),
        )
      }
      const snapshot = { ...turn }
      launch(
        (async () => {
          if (
            !(await roots.get(event.sessionID)) ||
            disposed ||
            turns.get(event.sessionID)?.id !== snapshot.id
          )
            return
          const result = await observer.observe(
            {
              host: "opencode",
              sessionId: event.sessionID,
              turnId: snapshot.id,
              step: snapshot.step,
              messages,
            },
            {
              name: "opencode",
              complete: async (request) => {
                const response = await ctx.experimental.generate.text(
                  {
                    model: event.model,
                    prompt: `${request.system}\n\n${request.prompt}`,
                  },
                  { signal: request.signal },
                )
                return { text: response.text }
              },
            },
          )
          if (result.status === "shown" && !disposed)
            await rpc.events.emit("changed", { sessionId: event.sessionID })
        })(),
      )
    })
    return async () => {
      disposed = true
      lifetime.abort()
      observer.dispose()
      await Promise.allSettled(jobs)
      turns.clear()
      roots.clear()
    }
  },
} satisfies Plugin.Plugin
