import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { configDirectory, configSchema } from "../core/config.js"
import { hookConfigPath, installHooks } from "../adapters/install.js"
import { object } from "../providers/json-lines.js"
import { PACKAGE_NAME, VERSION } from "../version.js"
import { readOptional, updateFile } from "./files.js"
import { installLauncher } from "./launcher.js"
import { installOpenCode, openCodeConfigPath } from "./opencode.js"

export const targets = ["opencode", "codex", "claude-code", "mcp"] as const
export type Target = (typeof targets)[number]

export function parseTargets(value: string): Target[] {
  const names = [...new Set(value.split(",").map((name) => name.trim()))]
  if (!names.length || names.some((name) => !targets.includes(name as Target)))
    throw new Error(
      "Choose opencode, codex, claude-code, or mcp (comma-separated for several clients)",
    )
  return names as Target[]
}

export async function packageDirectory(cliPath: string): Promise<string> {
  for (const path of [dirname(cliPath), dirname(dirname(cliPath))]) {
    const text = await readOptional(join(path, "package.json"))
    if (text !== undefined && object(JSON.parse(text)).name === PACKAGE_NAME) return path
  }
  throw new Error("Cannot find the installed You Should Know package")
}

export async function managedRoot(cliPath: string): Promise<string | undefined> {
  if (basename(dirname(dirname(dirname(cliPath)))) !== "versions") return undefined
  const root = resolve(dirname(cliPath), "../../..")
  return (await readOptional(join(root, "installation.json"))) !== undefined ? root : undefined
}

export async function forgetTarget(cliPath: string, target: Target): Promise<void> {
  const root = await managedRoot(cliPath)
  if (!root) return
  await updateFile(join(root, "installation.json"), (text) => {
    if (!text) return undefined
    const receipt = object(JSON.parse(text))
    if (!Array.isArray(receipt.targets)) return text
    return `${JSON.stringify({ ...receipt, targets: receipt.targets.filter((item) => item !== target) }, null, 2)}\n`
  })
}

export async function executable(name: string, env = process.env): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const directory of directories)
    for (const extension of extensions) {
      const path = resolve(directory, name + extension)
      try {
        await access(path, constants.X_OK)
        return path
      } catch {}
    }
  return undefined
}

async function enableCodexHooks(env: NodeJS.ProcessEnv): Promise<boolean> {
  const codex = await executable("codex", env)
  if (!codex) return false
  const windowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(codex)
  const result = spawnSync(windowsScript ? `"${codex}"` : codex, ["features", "enable", "hooks"], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    shell: windowsScript,
  })
  return result.status === 0
}

export async function configureTarget(
  target: Target,
  options: {
    cliPath: string
    packagePath: string
    nodePath?: string
    env?: NodeJS.ProcessEnv
    remove?: boolean
  },
): Promise<string> {
  const env = options.env ?? process.env
  if (target === "opencode") {
    const path = await openCodeConfigPath(env)
    await installOpenCode({ path, packagePath: options.packagePath, remove: options.remove })
    return `${options.remove ? "Disconnected" : "Connected"} OpenCode: ${path}`
  }
  if (target === "mcp") {
    return JSON.stringify(
      {
        mcpServers: {
          "you-should-know": {
            command: options.nodePath ?? process.execPath,
            args: [options.cliPath, "mcp", "--cwd", "/absolute/path/to/project"],
          },
        },
      },
      null,
      2,
    )
  }
  const path = hookConfigPath(target, env)
  await installHooks({
    host: target,
    path,
    cliPath: options.cliPath,
    nodePath: options.nodePath,
    remove: options.remove,
  })
  if (options.remove) return `Disconnected ${target}: ${path}`
  const enabled = target === "codex" && (await enableCodexHooks(env))
  return `Connected ${target}: ${path}${target === "codex" ? (enabled ? "\nCodex hooks enabled." : "\nStart Codex with hooks enabled: codex --enable hooks") : ""}`
}

export async function setup(options: {
  cliPath: string
  host?: string
  root?: string
  noPath?: boolean
  provider?: string
  model?: string
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  options.root ??= await managedRoot(options.cliPath)
  const env = options.env ?? process.env
  const packagePath = await packageDirectory(options.cliPath)
  const receiptPath = options.root ? join(options.root, "installation.json") : undefined
  const previous = receiptPath ? await readOptional(receiptPath) : undefined
  const receipt = previous ? object(JSON.parse(previous)) : {}
  let selected: Target[]
  let reader: ReturnType<typeof createInterface> | undefined
  const question = async (prompt: string) => {
    if (!process.stdin.isTTY)
      throw new Error(
        "Interactive setup needs a terminal. Use --host opencode, --host codex, or --host claude-code.",
      )
    reader ??= createInterface({ input: process.stdin, output: process.stdout })
    return (await reader.question(prompt)).trim()
  }
  try {
    console.log(`\nYou Should Know ${VERSION}\n`)
    if (options.host) selected = parseTargets(options.host)
    else if (Array.isArray(receipt.targets) && receipt.targets.length)
      selected = parseTargets(receipt.targets.join(","))
    else {
      console.log(
        "Connect your coding agent:\n  1. OpenCode (Desktop + terminal)\n  2. Codex\n  3. Claude Code\n  4. Another MCP client\n",
      )
      const answer =
        (await question("Choose a client [1], or several numbers separated by commas: ")) || "1"
      selected = parseTargets(
        answer
          .split(",")
          .map((value) => targets[Number(value.trim()) - 1] ?? value.trim())
          .join(","),
      )
    }
    const configPath = join(configDirectory(env), "config.json")
    if (selected.some((target) => target !== "opencode")) {
      const existing = await readOptional(configPath)
      if (existing === undefined) {
        let provider = options.provider
        if (!provider && !(await executable("codex", env))) {
          if (!process.stdin.isTTY)
            throw new Error(
              "Install and sign in to Codex, or choose --provider openai-compatible|anthropic --model MODEL_ID",
            )
          const answer =
            (await question(
              "Observer provider: 1. Codex account  2. OpenAI-compatible API  3. Anthropic API [1]: ",
            )) || "1"
          provider =
            (
              { "1": "codex", "2": "openai-compatible", "3": "anthropic" } as Record<string, string>
            )[answer] ?? answer
        }
        provider ??= "codex"
        const model =
          options.model ?? (provider !== "codex" ? await question("Model ID: ") : undefined)
        const config = configSchema.parse({
          provider: { type: provider, ...(model ? { model } : {}) },
        })
        if (provider !== "codex" && !config.provider.model)
          throw new Error("An API provider requires a model ID")
        await updateFile(configPath, (text) => text ?? `${JSON.stringify(config, null, 2)}\n`)
        if (provider !== "codex")
          console.log(
            `Set ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} in your agent's environment. Configuration: ${configPath}`,
          )
      } else configSchema.parse(JSON.parse(existing))
    }
    for (const target of selected)
      console.log(await configureTarget(target, { cliPath: options.cliPath, packagePath, env }))
    if (options.root) {
      const launcher = await installLauncher({
        cliPath: options.cliPath,
        nodePath: process.execPath,
        root: options.root,
        env,
        configurePath: !options.noPath,
      })
      const retained = Array.isArray(receipt.targets)
        ? (receipt.targets.filter((target) => targets.includes(target as Target)) as Target[])
        : []
      await updateFile(
        receiptPath!,
        () =>
          `${JSON.stringify({ version: VERSION, targets: [...new Set([...retained, ...selected])], packagePath, launcher }, null, 2)}\n`,
      )
      console.log(
        `\nInstalled: ${launcher}\nOpen a new terminal to use ysk, or run the path above now.`,
      )
    }
    if (selected.includes("opencode"))
      console.log("OpenCode reloads its plugin configuration automatically.")
    if (selected.some((target) => target === "codex" || target === "claude-code"))
      console.log(
        "Notes appear on your next prompt. Run ysk watch in your project for a live feed.",
      )
    console.log("\nSetup complete. Background observations use your model's quota.")
  } finally {
    reader?.close()
  }
}
