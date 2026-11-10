import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

export const observerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    language: z.enum(["auto", "en", "ru", "zh"]).default("auto"),
    minSteps: z.number().int().min(1).max(100).default(6),
    minIntervalMs: z.number().int().min(0).max(3_600_000).default(120_000),
    maxChecksPerSession: z.number().int().min(1).max(200).default(20),
    maxChecksPerHour: z.number().int().min(1).max(120).default(8),
    timeoutMs: z.number().int().min(1_000).max(180_000).default(45_000),
    maxContextChars: z.number().int().min(2_000).max(120_000).default(40_000),
    maxMessageChars: z.number().int().min(500).max(20_000).default(6_000),
    minConfidence: z.number().min(0.5).max(1).default(0.85),
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .strict()

export const providerConfigSchema = z
  .object({
    type: z.enum(["codex", "openai-compatible", "anthropic"]).default("codex"),
    model: z.string().min(1).max(200).optional(),
    baseUrl: z.url().optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    executable: z.string().min(1).default("codex"),
  })
  .strict()

export const configSchema = z
  .object({
    observer: observerConfigSchema.default(() => observerConfigSchema.parse({})),
    provider: providerConfigSchema.default(() => providerConfigSchema.parse({})),
  })
  .strict()

export type ObserverConfig = z.infer<typeof observerConfigSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type Config = z.infer<typeof configSchema>

export function observerOverrides(value: unknown): Partial<ObserverConfig> {
  const parsed = observerConfigSchema.partial().parse(value)
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => Object.hasOwn(value as object, key)),
  )
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "you-should-know")
}

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.YSK_DATA_DIR
    ? resolve(env.YSK_DATA_DIR)
    : join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "you-should-know")
}

export async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw new Error(`Cannot read valid JSON from ${path}`, { cause: error })
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

export async function loadConfig(options: {
  workspace: string
  configPath?: string
  env?: NodeJS.ProcessEnv
}): Promise<Config> {
  const env = options.env ?? process.env
  const path = options.configPath ?? join(configDirectory(env), "config.json")
  const global = configSchema.parse((await readJson(path)) ?? {})
  const local = await readJson(join(options.workspace, ".you-should-know.json"))
  const overrides = observerOverrides(local ?? {})
  return { ...global, observer: observerConfigSchema.parse({ ...global.observer, ...overrides }) }
}
