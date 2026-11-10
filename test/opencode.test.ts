import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/opencode/index.js"
import { languageOf } from "../src/opencode/copy.js"
import { deferred, observation } from "./helpers.js"

test(
  "native hooks return before inference and a new prompt cancels stale work",
  { timeout: 5_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ysk-opencode-test-"))
    const before = { config: process.env.XDG_CONFIG_HOME, data: process.env.YSK_DATA_DIR }
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.YSK_DATA_DIR = join(root, "state")
    const hooks = new Map<string, (event: never) => unknown>()
    const started = deferred<AbortSignal>()
    const changed = deferred<void>()
    let notifications = 0
    let cleanup: (() => Promise<void>) | undefined
    try {
      const ctx = {
        location: { directory: root },
        options: { minSteps: 1, minIntervalMs: 0 },
        rpc: {
          register: async () => ({
            events: {
              emit: async () => {
                notifications++
                if (notifications === 2) changed.resolve()
              },
            },
          }),
        },
        session: {
          hook: async (name: string, handler: (event: never) => unknown) => {
            hooks.set(name, handler)
          },
          get: async () => ({ parentID: undefined }),
        },
        experimental: {
          generate: {
            text: async (
              input: { model: unknown; prompt: string },
              options: { signal: AbortSignal },
            ) => {
              assert.deepEqual(input.model, { id: "fixture", providerID: "fixture" })
              assert.ok(input.prompt.includes(observation.messages[0]!.text))
              assert.equal("tools" in input, false)
              started.resolve(options.signal)
              return new Promise(() => {})
            },
          },
        },
      } as unknown as Plugin.Context
      cleanup = await plugin.setup(ctx)
      assert.equal(
        hooks.get("prompt")!({ sessionID: "session", messageID: "turn-1" } as never),
        undefined,
      )
      assert.equal(
        hooks.get("context")!({
          sessionID: "session",
          messages: observation.messages,
          model: { id: "fixture", providerID: "fixture" },
        } as never),
        undefined,
      )
      const signal = await started.promise
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      hooks.get("prompt")!({ sessionID: "session", messageID: "turn-2" } as never)
      await aborted
      await changed.promise
      assert.equal(signal.aborted, true)
      assert.equal(notifications, 2)
    } finally {
      await cleanup?.()
      for (const [key, value] of [
        ["XDG_CONFIG_HOME", before.config],
        ["YSK_DATA_DIR", before.data],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)

test("automatic UI language follows the host locale while explicit language wins", () => {
  assert.equal(languageOf("auto", "ru-RU"), "ru")
  assert.equal(languageOf("auto", "zh-CN"), "zh")
  assert.equal(languageOf("en", "ru-RU"), "en")
})
