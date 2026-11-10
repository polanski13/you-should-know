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
      .ysk-note { box-sizing:border-box; width:100%; min-width:0; padding:8px; font-family:inherit; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
      .ysk-body { min-width:0; max-height:min(360px,50vh); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
      .ysk-note h3 { margin:0 0 10px; font-size:13px; font-weight:600; line-height:1.45; }
      .ysk-note p { margin:0; white-space:pre-wrap; }
      .ysk-explanation { opacity:.82; }
      .ysk-note details { margin-top:12px; font-size:11px; }
      .ysk-note summary { width:fit-content; max-width:100%; cursor:pointer; opacity:.7; }
      .ysk-note summary:hover, .ysk-note summary:focus-visible { opacity:1; }
      .ysk-note blockquote { margin:8px 0 0; padding:2px 0 2px 10px; border-left:2px solid color-mix(in srgb,currentColor 20%,transparent); opacity:.75; }
      .ysk-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin-top:12px; padding-top:10px; border-top:1px solid color-mix(in srgb,currentColor 10%,transparent); }
      .ysk-note .ysk-actions button { box-sizing:border-box; width:100%; min-width:0; max-width:100%; height:auto; min-height:28px; padding:6px 8px; font-size:12px; line-height:1.35; white-space:normal; overflow-wrap:anywhere; }
      .ysk-note .ysk-error { margin-top:10px; font-size:12px; }
    `,
    )
    ctx.add(ComposerPill, {
      id: "observation",
      show: (props) => {
        const note = active()
        if (!note || note.sessionId !== props.session.id) return undefined
        return {
          label: note.kind === "heads_up" ? t().headsUp : t().explainer,
          icon: "info",
          title: t().explainer,
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
                <div class="ysk-body" tabindex="0" aria-label={note().summary}>
                  <h3>{note().summary}</h3>
                  <p class="ysk-explanation">{note().explanation}</p>
                  <details>
                    <summary>
                      {t().evidence} · {note().evidence.length}
                    </summary>
                    <For each={note().evidence}>
                      {(evidence) => <blockquote>{evidence.quote}</blockquote>}
                    </For>
                  </details>
                </div>
                <Show when={failed()}>
                  <p class="ysk-error" role="alert">
                    {t().unavailable}
                  </p>
                </Show>
                <div class="ysk-actions">
                  <ctx.ui.Button
                    size="small"
                    variant="contrast"
                    disabled={busy()}
                    onClick={() => void act("helpful")}
                  >
                    {t().understood}
                  </ctx.ui.Button>
                  <ctx.ui.Button
                    size="small"
                    variant="neutral"
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
                  </ctx.ui.Button>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost-muted"
                    disabled={busy()}
                    onClick={() => void act("known")}
                  >
                    {t().known}
                  </ctx.ui.Button>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost-muted"
                    disabled={busy()}
                    onClick={() => void act("dismissed")}
                  >
                    {t().dismiss}
                  </ctx.ui.Button>
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
