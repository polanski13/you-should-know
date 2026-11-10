import { createSignal, onCleanup, Show, For } from "solid-js"
import { Command, ComposerPill, createKeyed, Plugin, Style } from "@opencode/plugin/gui"
import type { Note } from "../core/types.js"
import { copy, languageOf } from "./copy.js"
import { YouShouldKnow } from "./rpc.js"

export default Plugin.define({
  setup(ctx) {
    const [notes, setNotes] = createSignal<Note[]>([])
    const [error, setError] = createSignal(false)
    const t = () => copy[languageOf(ctx.options.language, ctx.locale.locale())]
    const active = () => notes().find((note) => note.status === "unread")
    let refresh = async () => {}

    createKeyed(
      () => {
        const session = ctx.sessions.current()
        return session
          ? { session, client: session.server.client, directory: session.directory }
          : undefined
      },
      ({ session, client, directory }) => {
        const controller = new AbortController()
        const rpc = client.rpc(YouShouldKnow)
        const options = { location: { directory }, signal: controller.signal }
        let revision = 0
        setNotes([])
        refresh = async () => {
          const request = ++revision
          try {
            const value = await rpc.notes({ sessionId: session.id }, options)
            if (!controller.signal.aborted && request === revision) {
              setNotes(value)
              setError(false)
            }
          } catch {
            if (!controller.signal.aborted) setError(true)
          }
        }
        const stop = rpc.events.on(
          "changed",
          (event) => {
            if (event.data.sessionId === session.id && event.location.directory === directory)
              void refresh()
          },
          { signal: controller.signal },
        )
        void refresh()
        onCleanup(() => {
          controller.abort()
          stop()
          refresh = async () => {}
        })
      },
      { otherwise: () => setNotes([]) },
    )

    ctx.add(
      Style,
      `
      .ysk-note { width:min(400px,calc(100vw - 48px)); padding:14px; font:inherit; }
      .ysk-note p { margin:0 0 12px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
      .ysk-note details { margin:12px 0; font-size:12px; opacity:.8; }
      .ysk-note summary { cursor:pointer; }
      .ysk-note blockquote { margin:8px 0; padding-left:10px; border-left:2px solid currentColor; }
      .ysk-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
      .ysk-actions button { font:inherit; font-size:12px; color:inherit; padding:6px 10px; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:7px; background:transparent; cursor:pointer; transition:background .12s ease; }
      .ysk-actions button:hover { background:color-mix(in srgb,currentColor 8%,transparent); }
      .ysk-actions button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
      .ysk-actions button:disabled { opacity:.5; cursor:wait; }
      .ysk-error { font-size:12px; }
      @media(prefers-reduced-motion:reduce) { .ysk-actions button { transition:none; } }
    `,
    )
    ctx.add(ComposerPill, {
      id: "observation",
      show: (props) => {
        const note = active()
        if (!note || note.sessionId !== props.session.id) return undefined
        return {
          label: note.summary,
          title: `${note.kind === "heads_up" ? t().headsUp : t().explainer} · ${note.summary}`,
        }
      },
      menu: (props) => {
        const [busy, setBusy] = createSignal(false)
        const [failed, setFailed] = createSignal(false)
        const act = async (feedback: "known" | "dismissed" | "helpful") => {
          const note = active()
          if (!note || busy() || note.sessionId !== props.session.id) return
          setBusy(true)
          try {
            await props.session.server.client
              .rpc(YouShouldKnow)
              .feedback(
                { id: note.id, feedback },
                { location: { directory: props.session.directory }, signal: ctx.signal },
              )
            await refresh()
            props.close()
          } catch {
            setFailed(true)
          } finally {
            setBusy(false)
          }
        }
        return (
          <Show when={active()}>
            {(note) => (
              <section class="ysk-note" aria-label={t().explainer}>
                <p>{note().explanation}</p>
                <details>
                  <summary>{t().evidence}</summary>
                  <For each={note().evidence}>
                    {(evidence) => <blockquote>{evidence.quote}</blockquote>}
                  </For>
                </details>
                <Show when={failed()}>
                  <p class="ysk-error" role="alert">
                    {t().unavailable}
                  </p>
                </Show>
                <div class="ysk-actions">
                  <button disabled={busy()} onClick={() => void act("helpful")}>
                    {t().understood}
                  </button>
                  <button disabled={busy()} onClick={() => void act("known")}>
                    {t().known}
                  </button>
                  <button
                    disabled={busy()}
                    onClick={() => {
                      if (note().sessionId !== props.session.id) return
                      props.screen.composer.insert(
                        `\n${t().discussing}\n\n${note().summary}\n${note().explanation}\n`,
                      )
                      props.screen.composer.focus()
                      props.close()
                    }}
                  >
                    {t().discuss}
                  </button>
                  <button disabled={busy()} onClick={() => void act("dismissed")}>
                    {t().dismiss}
                  </button>
                </div>
              </section>
            )}
          </Show>
        )
      },
    })
    ctx.add(Command, {
      id: "notes",
      title: "You Should Know: refresh notes",
      slash: { name: "ysk" },
      run: async () => {
        await refresh()
        if (!active())
          ctx.toast.show({
            title: "You Should Know",
            description: error() ? t().unavailable : t().empty,
          })
      },
    })
  },
})
