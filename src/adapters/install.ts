import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import lockfile from "proper-lockfile"
import { isErrno } from "../core/config.js"
import { object } from "../providers/json-lines.js"

const marker = "--managed-by-ysk"
const events = ["PostToolUse", "Stop", "UserPromptSubmit", "SessionEnd"] as const

export function hookConfigPath(host: "codex" | "claude-code", env = process.env): string {
  return host === "codex"
    ? join(env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json")
    : join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function mergeHooks(
  existing: Record<string, unknown>,
  host: "codex" | "claude-code",
  cliPath: string,
  remove = false,
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
        command: `node ${shellQuote(cliPath)} hook --host ${host} ${marker}`,
        timeout: async ? 190 : 10,
        ...(async ? { async: true } : {}),
      }
      if (host === "codex")
        handler.commandWindows = `node "${cliPath.replaceAll('"', '\\"')}" hook --host ${host} ${marker}`
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
}): Promise<boolean> {
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 })
  const guard = `${options.path}.ysk-write`
  await (await open(guard, "a", 0o600)).close()
  const release = await lockfile.lock(guard, { retries: 5 })
  try {
    let original: string | undefined
    try {
      original = await readFile(options.path, "utf8")
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error
    }
    if (original === undefined && options.remove) return false
    const parsed: unknown = original === undefined ? {} : JSON.parse(original)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Hook configuration must be a JSON object")
    const next = mergeHooks(
      parsed as Record<string, unknown>,
      options.host,
      options.cliPath,
      options.remove,
    )
    if (JSON.stringify(parsed) === JSON.stringify(next)) return false
    if (original !== undefined) {
      try {
        await copyFile(options.path, `${options.path}.before-ysk`, constants.COPYFILE_EXCL)
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error
      }
    }
    const temporary = `${options.path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, options.path)
    } finally {
      await rm(temporary, { force: true })
    }
    return true
  } finally {
    await release()
  }
}
