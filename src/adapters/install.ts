import { homedir } from "node:os"
import { join } from "node:path"
import { object } from "../providers/json-lines.js"
import { shellQuote, updateFile, windowsQuote } from "../setup/files.js"

const marker = "--managed-by-ysk"
const events = ["PostToolUse", "Stop", "UserPromptSubmit", "SessionEnd"] as const

export function hookConfigPath(host: "codex" | "claude-code", env = process.env): string {
  return host === "codex"
    ? join(env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json")
    : join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")
}

export function mergeHooks(
  existing: Record<string, unknown>,
  host: "codex" | "claude-code",
  cliPath: string,
  remove = false,
  nodePath = process.execPath,
): Record<string, unknown> {
  if (
    existing.hooks !== undefined &&
    (!existing.hooks || typeof existing.hooks !== "object" || Array.isArray(existing.hooks))
  )
    throw new Error("Existing hooks must be a JSON object; no changes were made")
  const hooks = { ...object(existing.hooks) }
  for (const event of events) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
      throw new Error(`Existing ${event} hooks must be an array; no changes were made`)
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const filtered = groups
      .map((group) => {
        const value = object(group)
        if (!Array.isArray(value.hooks)) return group
        return {
          ...value,
          hooks: value.hooks.filter((hook) => !String(object(hook).command ?? "").includes(marker)),
        }
      })
      .filter(
        (group) =>
          !Array.isArray(object(group).hooks) || (object(group).hooks as unknown[]).length > 0,
      )
    if (!remove) {
      const async = event === "PostToolUse" || event === "Stop"
      const handler: Record<string, unknown> = {
        type: "command",
        command: `${shellQuote(nodePath.replaceAll("\\", "/"))} ${shellQuote(cliPath.replaceAll("\\", "/"))} hook --host ${host} ${marker}`,
        timeout: async ? 190 : 10,
        ...(async ? { async: true } : {}),
      }
      if (host === "codex")
        handler.commandWindows = `${windowsQuote(nodePath)} ${windowsQuote(cliPath)} hook --host ${host} ${marker}`
      filtered.push({ ...(event === "PostToolUse" ? { matcher: ".*" } : {}), hooks: [handler] })
    }
    if (filtered.length) hooks[event] = filtered
    else delete hooks[event]
  }
  return { ...existing, hooks }
}

export async function installHooks(options: {
  host: "codex" | "claude-code"
  cliPath: string
  path: string
  remove?: boolean
  nodePath?: string
}): Promise<boolean> {
  return updateFile(options.path, (original) => {
    if (original === undefined && options.remove) return undefined
    const parsed: unknown = original === undefined ? {} : JSON.parse(original)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Hook configuration must be a JSON object")
    const next = mergeHooks(
      parsed as Record<string, unknown>,
      options.host,
      options.cliPath,
      options.remove,
      options.nodePath,
    )
    return JSON.stringify(parsed) === JSON.stringify(next)
      ? original
      : `${JSON.stringify(next, null, 2)}\n`
  })
}
