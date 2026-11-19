import { appendFile } from "node:fs/promises"
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

export function localUsageLog(path: string | undefined, workspace: string): UsageSink | undefined {
  if (!path) return undefined
  const project = digest(workspace)
  return async ({ sessionId, turnId, ...event }) => {
    const row = { ...event, project, session: digest(sessionId), turn: digest(turnId) }
    await appendFile(path, JSON.stringify(row) + "\n", { mode: 0o600 })
  }
}
