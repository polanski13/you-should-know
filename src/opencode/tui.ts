import type { Plugin } from "@opencode/plugin/tui"
import { copy, languageOf } from "./copy.js"
import { YouShouldKnow } from "./rpc.js"

export default {
  id: "you-should-know-tui",
  setup(ctx) {
    const t = copy[languageOf(ctx.options.language, process.env.LANG)]
    const rpc = ctx.client.rpc(YouShouldKnow)
    const options = { location: ctx.location }
    const current = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const stop = rpc.events.on("changed", async (event) => {
      if (
        event.data.sessionId !== current() ||
        event.location.directory !== ctx.location?.directory
      )
        return
      try {
        const note = (await rpc.notes({ sessionId: event.data.sessionId }, options)).find(
          (item) => item.status === "unread",
        )
        if (note && note.sessionId === current())
          ctx.ui.toast.show({
            title: t.headsUp,
            message: `${note.summary}\n/ysk · ${t.more}`,
            duration: 8_000,
          })
      } catch {}
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "you-should-know.notes",
          title: t.notes,
          palette: true,
          slash: { name: "ysk" },
          run: async () => {
            const sessionId = current()
            if (!sessionId) return
            try {
              const notes = await rpc.notes({ sessionId }, options)
              if (!notes.length) {
                await ctx.ui.dialog.alert({ title: t.notes, message: t.empty })
                return
              }
              const id = await ctx.ui.dialog.select({
                title: t.notes,
                options: notes.map((note) => ({
                  title: note.summary,
                  description: note.status,
                  value: note.id,
                })),
              })
              const note = notes.find((item) => item.id === id)
              if (!note || current() !== sessionId) return
              await ctx.ui.dialog.alert({ title: note.summary, message: note.explanation })
              const action = await ctx.ui.dialog.select({
                title: t.notes,
                options: [
                  { title: t.understood, value: "helpful" },
                  { title: t.known, value: "known" },
                  { title: t.discuss, value: "discuss" },
                  { title: t.dismiss, value: "dismissed" },
                ],
              })
              if (!action || current() !== sessionId) return
              if (action === "discuss")
                await ctx.client.session.prompt({
                  sessionID: sessionId,
                  text: `${t.discussing}\n\n${note.summary}\n${note.explanation}`,
                })
              else if (action === "known" || action === "dismissed" || action === "helpful")
                await rpc.feedback({ id: note.id, feedback: action }, options)
            } catch {
              ctx.ui.toast.show({ message: t.unavailable, variant: "error" })
            }
          },
        },
      ],
    }))
    return stop
  },
} satisfies Plugin.Definition
