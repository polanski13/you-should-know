import { z } from "zod"
import { cleanText } from "../core/context.js"
import { createRuntime } from "../runtime.js"
import type { Runtime } from "../runtime.js"
import { readTranscript } from "./transcript.js"

const inputSchema = z.object({
  session_id: z.string().min(1).max(240),
  cwd: z.string().min(1),
  hook_event_name: z.string(),
  transcript_path: z.string().nullish(),
  turn_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  agent_id: z.string().optional(),
})

export async function handleHook(
  raw: unknown,
  options: {
    host: "codex" | "claude-code"
    env?: NodeJS.ProcessEnv
    runtime?: Runtime
  },
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env
  if (env.YSK_OBSERVER === "1") return {}
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) return {}
  const input = parsed.data
  if (input.stop_hook_active || input.agent_id) return {}
  const runtime = options.runtime ?? (await createRuntime(input.cwd, undefined, env))
  if (input.hook_event_name === "UserPromptSubmit") {
    await runtime.observer.invalidate(input.session_id)
    const notes = await runtime.observer.notifications(input.session_id)
    if (!notes.length) return {}
    const note = notes[0]!
    return {
      systemMessage: cleanText(
        `You Should Know · ${note.summary}\n${note.explanation}\n\nysk show ${note.id} · ysk feedback ${note.id} known`,
      ),
    }
  }
  if (input.hook_event_name === "SessionEnd") {
    await runtime.observer.invalidate(input.session_id)
    return {}
  }
  if (!new Set(["PostToolUse", "Stop"]).has(input.hook_event_name) || !input.transcript_path)
    return {}
  const transcript = await readTranscript(input.transcript_path)
  if (
    input.turn_id &&
    transcript.turnId &&
    options.host === "codex" &&
    transcript.turnId !== input.turn_id
  )
    return {}
  const turnId = input.turn_id ?? transcript.turnId
  if (!turnId) return {}
  await runtime.observer.observe(
    {
      host: options.host,
      sessionId: input.session_id,
      turnId,
      step: transcript.steps,
      messages: transcript.messages,
    },
    runtime.provider,
  )
  return {}
}
