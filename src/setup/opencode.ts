import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { object } from "../providers/json-lines.js"
import { PACKAGE_NAME } from "../version.js"
import { readOptional, updateFile } from "./files.js"

export async function openCodeConfigPath(env = process.env): Promise<string> {
  const directory = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const jsonc = join(directory, "opencode.jsonc")
  if ((await readOptional(jsonc)) !== undefined) return jsonc
  const json = join(directory, "opencode.json")
  return (await readOptional(json)) !== undefined ? json : jsonc
}

async function isOurPlugin(
  value: unknown,
  directory: string,
  packagePath: string,
): Promise<boolean> {
  const target = typeof value === "string" ? value : object(value).package
  if (typeof target !== "string") return false
  if (target === PACKAGE_NAME || target.startsWith(`${PACKAGE_NAME}@`) || target === packagePath)
    return true
  if (!isAbsolute(target) && !target.startsWith(".") && !target.startsWith("file:")) return false
  try {
    const path = target.startsWith("file:") ? fileURLToPath(target) : resolve(directory, target)
    const manifest = await readOptional(join(path, "package.json"))
    return manifest !== undefined && object(JSON.parse(manifest)).name === PACKAGE_NAME
  } catch {
    return false
  }
}

export async function installOpenCode(options: {
  path: string
  packagePath: string
  remove?: boolean
}): Promise<boolean> {
  return updateFile(options.path, async (original) => {
    if (original === undefined && options.remove) return undefined
    let text =
      original ?? '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": []\n}\n'
    const errors: ParseError[] = []
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(
        "OpenCode configuration must be a valid JSON/JSONC object; no changes were made",
      )
    const config = object(parsed)
    if (config.plugins !== undefined && !Array.isArray(config.plugins))
      throw new Error("OpenCode plugins must be an array; no changes were made")
    const plugins = (config.plugins ?? []) as unknown[]
    const matches: number[] = []
    for (let i = 0; i < plugins.length; i++) {
      if (await isOurPlugin(plugins[i], dirname(options.path), options.packagePath)) matches.push(i)
    }
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  "
    const formattingOptions = {
      insertSpaces: !indent.includes("\t"),
      tabSize: indent.length,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    }
    const edit = (path: (string | number)[], value: unknown) => {
      text = applyEdits(text, modify(text, path, value, { formattingOptions }))
    }
    if (options.remove) {
      for (const index of matches.toReversed()) edit(["plugins", index], undefined)
    } else if (matches.length) {
      const first = matches[0]!
      if (typeof plugins[first] === "string") {
        if (plugins[first] !== options.packagePath) edit(["plugins", first], options.packagePath)
      } else if (object(plugins[first]).package !== options.packagePath)
        edit(["plugins", first, "package"], options.packagePath)
      for (const index of matches.slice(1).toReversed()) edit(["plugins", index], undefined)
    } else {
      if (config.plugins === undefined) edit(["plugins"], [])
      edit(["plugins", -1], { package: options.packagePath, options: { language: "auto" } })
    }
    return text
  })
}
