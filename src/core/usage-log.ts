import { open } from "node:fs/promises"
import { digest } from "./context.js"
import type { ModelUsage, Observation } from "./types.js"

interface UsageEvent {
  startedAt: number
  durationMs: number
  host: Observation["host"]
  sessionId: string
  turnId: string
  provider: string
  model?: string
  status: string
  reason?: string
  usage?: ModelUsage
}

export type UsageSink = (event: UsageEvent) => Promise<void>

export function localUsageLog(path: string | undefined, project: string): UsageSink | undefined {
  if (!path) return undefined
  return async ({ sessionId, turnId, ...event }) => {
    const row = { ...event, project, session: digest(sessionId), turn: digest(turnId) }
    const file = await open(path, "a", 0o600)
    try {
      if (process.platform !== "win32" && (await file.stat()).mode & 0o077) await file.chmod(0o600)
      await file.appendFile(JSON.stringify(row) + "\n")
    } finally {
      await file.close()
    }
  }
}
