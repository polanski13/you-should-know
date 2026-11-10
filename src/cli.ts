#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { configDirectory, configSchema, isErrno, loadConfig } from "./core/config.js"
import { cleanText } from "./core/context.js"
import { feedbackSchema, observationSchema } from "./core/types.js"
import type { Note } from "./core/types.js"
import { createRuntime } from "./runtime.js"
import { handleHook } from "./adapters/hooks.js"
import { hookConfigPath, installHooks } from "./adapters/install.js"

const help = `You Should Know · a quiet second opinion for your coding agent

Usage: ysk <command> [options]

  init                         Create your user configuration
  install codex|claude-code     Add background observation hooks
  uninstall codex|claude-code   Remove only this project's hook registrations
  check                        Read an observation as JSON from stdin
  notes                        List this project's saved notes
  show <id>                    Read a note and its evidence
  feedback <id> <action>        known, dismissed, helpful, or irrelevant
  pause | resume               Pause or resume this project's observer
  watch                        Print new notes as they arrive
  doctor                       Check configuration and provider prerequisites
  mcp                          Serve the MCP tools over stdio

Options:
  --cwd <directory>            Project directory (default: current directory)
  --config <path>              User configuration file
  --session <id>               Filter notes by session
  --json                       Machine-readable output
  --manual                     Check now, while retaining budget and deduplication limits
  --help                       Show this help
  --version                    Show the version

Observation sends a bounded conversation excerpt to your configured model.
Model requests use that provider's quota. The observer never executes model tools.
`

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 2_000_000) throw new Error("Input exceeds the 2 MB limit")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function formatNote(note: Note, detailed = false): string {
  const lines = [
    `${note.kind === "heads_up" ? "Heads up" : "You should know"} · ${note.summary}`,
    note.explanation,
  ]
  if (detailed) {
    for (const evidence of note.evidence) lines.push(`\n[${evidence.messageId}] ${evidence.quote}`)
    lines.push(`\nID: ${note.id}\nStatus: ${note.status}\nSession: ${note.sessionId}`)
  }
  return cleanText(lines.join("\n\n"))
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      config: { type: "string" },
      session: { type: "string" },
      host: { type: "string" },
      json: { type: "boolean" },
      manual: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
      "managed-by-ysk": { type: "boolean" },
    },
  })
  const [command, first, second] = positionals
  if (values.version) {
    console.log("0.1.0")
    return
  }
  if (values.help || !command || command === "help") {
    console.log(help)
    return
  }
  if (command === "hook") {
    try {
      if (values.host !== "codex" && values.host !== "claude-code") {
        console.log("{}")
        return
      }
      const result = await handleHook(JSON.parse(await readStdin()), { host: values.host })
      console.log(JSON.stringify(result))
    } catch {
      console.log("{}")
    }
    return
  }
  const workspace = resolve(values.cwd ?? process.cwd())
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2))
  if (command === "init") {
    const path = values.config ?? join(configDirectory(), "config.json")
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, `${JSON.stringify(configSchema.parse({}), null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      console.log(
        `Created ${path}\nProvider: Codex, using your existing sign-in. Edit this file to choose another provider.`,
      )
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error
      console.log(`Configuration already exists: ${path}`)
    }
    return
  }
  if (command === "install" || command === "uninstall") {
    if (first !== "codex" && first !== "claude-code")
      throw new Error("Choose codex or claude-code. See the README for OpenCode and MCP setup.")
    const path = hookConfigPath(first)
    const changed = await installHooks({
      host: first,
      path,
      cliPath: fileURLToPath(import.meta.url),
      remove: command === "uninstall",
    })
    console.log(`${changed ? "Updated" : "Already up to date"}: ${path}`)
    if (command === "install") {
      console.log(
        "Background checks save notes locally. Notes appear on your next prompt; use ysk watch for a live feed.",
      )
      if (first === "codex") console.log("Run Codex with hooks enabled: codex --enable hooks")
    }
    return
  }
  if (command === "doctor") {
    const config = await loadConfig({ workspace, configPath: values.config })
    const provider = config.provider
    const checks = [{ name: "configuration", ok: true, detail: "valid" }]
    if (provider.type === "codex") {
      const result = spawnSync(provider.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      })
      const version = /(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? "")
      const compatible = version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 162)
      checks.push({
        name: "codex",
        ok: result.status === 0 && compatible,
        detail: compatible ? cleanText(result.stdout.trim()) : "Codex 0.162.0 or newer is required",
      })
      checks.push({
        name: "authentication",
        ok: true,
        detail: "Use codex login status to inspect your sign-in; no model request was made",
      })
    } else {
      const env =
        provider.apiKeyEnv ??
        (provider.type === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")
      checks.push({
        name: "model",
        ok: !!provider.model,
        detail: provider.model ?? "not configured",
      })
      checks.push({
        name: "credential",
        ok: !!process.env[env],
        detail: `${env}: ${process.env[env] ? "set" : "not set"}`,
      })
    }
    if (values.json) print({ checks })
    else
      for (const check of checks)
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`)
    if (checks.some((check) => !check.ok)) process.exitCode = 1
    return
  }
  const runtime = await createRuntime(workspace, values.config)
  switch (command) {
    case "check": {
      const input = observationSchema.parse(JSON.parse(await readStdin()))
      const result = await runtime.observer.observe(input, runtime.provider, values.manual)
      if (values.json || result.status !== "shown") print(result)
      else console.log(formatNote(result.note, true))
      if (result.status === "error") process.exitCode = 1
      return
    }
    case "notes": {
      const notes = await runtime.observer.notes(values.session)
      if (values.json) print(notes)
      else
        console.log(
          notes.length
            ? notes
                .map((note) => `${note.id}  ${note.status}\n${cleanText(note.summary)}`)
                .join("\n\n")
            : "Nothing needs your attention.",
        )
      return
    }
    case "show": {
      const note = (await runtime.observer.notes()).find((note) => note.id === first)
      if (!note) throw new Error("Note not found in this project")
      if (values.json) print(note)
      else console.log(formatNote(note, true))
      return
    }
    case "feedback": {
      if (!first) throw new Error("Provide a note ID and feedback")
      const note = await runtime.observer.feedback(first, feedbackSchema.parse(second))
      if (values.json) print(note)
      else console.log(`Saved: ${note.status}`)
      return
    }
    case "pause":
    case "resume":
      await runtime.observer.pause(command === "pause")
      console.log(
        command === "pause"
          ? "Suggestions paused for this project."
          : "Suggestions resumed for this project.",
      )
      return
    case "watch": {
      const shown = new Set<string>()
      let reading = false
      const refresh = async () => {
        if (reading) return
        reading = true
        try {
          for (const note of (await runtime.observer.notes(values.session)).toReversed()) {
            if (note.status !== "unread" || shown.has(note.id)) continue
            shown.add(note.id)
            console.log(`${formatNote(note)}\n\nysk feedback ${note.id} known\n`)
          }
        } finally {
          reading = false
        }
      }
      await refresh()
      const timer = setInterval(() => {
        void refresh().catch(() => undefined)
      }, 1_000)
      const close = () => {
        clearInterval(timer)
        runtime.observer.dispose()
      }
      process.once("SIGINT", close)
      process.once("SIGTERM", close)
      return
    }
    case "mcp": {
      const { serveMcp } = await import("./adapters/mcp.js")
      await serveMcp(runtime)
      return
    }
    default:
      throw new Error(`Unknown command: ${command}. Run ysk --help.`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  void main().catch((error: unknown) => {
    if (process.argv.includes("hook")) {
      console.log("{}")
      return
    }
    console.error(
      `You Should Know: ${error instanceof Error ? cleanText(error.message) : "Unexpected error"}`,
    )
    process.exitCode = 1
  })
}
