import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseTranscript } from "../src/adapters/transcript.js"
import { normalizeMessages } from "../src/adapters/messages.js"
import { installHooks, mergeHooks } from "../src/adapters/install.js"
import { handleHook } from "../src/adapters/hooks.js"
import { createRuntime } from "../src/runtime.js"
import { config, observation, provider } from "./helpers.js"

test("Codex rollout messages preserve user intent, tool results, and turn identity", () => {
  const rows = [
    { type: "turn_context", payload: { turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Keep it cheap" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: '{"command":"test"}' },
    },
    { type: "response_item", payload: { type: "function_call_output", output: "Tests failed" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "All tests pass" }],
      },
    },
  ]
  const result = parseTranscript(rows.map((row) => JSON.stringify(row)).join("\n"))
  assert.equal(result.turnId, "turn-1")
  assert.equal(result.steps, 1)
  assert.equal(result.messages[2]?.role, "tool")
  assert.equal(result.messages.at(-1)?.text, "All tests pass")
})

test("Claude tool-result messages are not mistaken for new user turns", () => {
  const result = parseTranscript(
    [
      { uuid: "user", message: { role: "user", content: "Original request" } },
      {
        uuid: "tool",
        message: { role: "user", content: [{ type: "tool_result", content: "Tests failed" }] },
      },
      {
        uuid: "agent",
        message: { role: "assistant", content: [{ type: "text", text: "Everything works" }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  )
  assert.equal(result.turnId, "user")
  assert.equal(result.steps, 1)
  assert.equal(result.messages[1]?.role, "tool")
})

test("transcript parsing tolerates partial records and excludes subagents and reasoning", () => {
  const rows = [
    '{"partial":',
    JSON.stringify({ uuid: "u", message: { role: "user", content: "Goal" } }),
    JSON.stringify({
      uuid: "s",
      isSidechain: true,
      message: { role: "assistant", content: "Subagent detail" },
    }),
    JSON.stringify({
      uuid: "a",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "Private reasoning" },
          { type: "text", text: "Public result" },
        ],
      },
    }),
  ]
  const result = parseTranscript(rows.join("\n"))
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[1]?.text, "Public result")
})

test("OpenCode messages extract structured tool results without images or reasoning", () => {
  const result = normalizeMessages([
    {
      role: "tool",
      content: [{ type: "tool-result", output: { type: "json", value: { passed: false } } }],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "Done" },
      ],
    },
  ])
  assert.equal(result[0]?.text, '{"passed":false}')
  assert.equal(result[1]?.text, "Done")
})

test("hook installation is idempotent and uninstall preserves unrelated settings", () => {
  const existing = {
    theme: "dark",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "my-existing-hook" }] }] },
  }
  const installed = mergeHooks(existing, "codex", "/a path/插件/cli.js")
  assert.deepEqual(mergeHooks(installed, "codex", "/a path/插件/cli.js"), installed)
  assert.deepEqual(mergeHooks(installed, "codex", "/different/path/cli.js", true), existing)
  assert.equal(existing.hooks.Stop[0]?.hooks.length, 1)
})

test("unexpected hook configuration shapes are not overwritten", () => {
  assert.throws(() => mergeHooks({ hooks: "important" }, "codex", "/cli.js"), /no changes/)
  assert.throws(() => mergeHooks({ hooks: { Stop: {} } }, "codex", "/cli.js"), /no changes/)
})

test("hook installer keeps an original backup and does not modify invalid JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-install-test-"))
  const path = join(root, "hooks.json")
  try {
    const original = '{"hooks":{},"description":"Keep this"}\n'
    await writeFile(path, original)
    await installHooks({ host: "codex", path, cliPath: "/has space/cli.js" })
    assert.equal(await readFile(`${path}.before-ysk`, "utf8"), original)
    assert.equal(await installHooks({ host: "codex", path, cliPath: "/has space/cli.js" }), false)
    await writeFile(path, "broken JSON")
    await assert.rejects(installHooks({ host: "codex", path, cliPath: "/cli.js" }))
    assert.equal(await readFile(path, "utf8"), "broken JSON")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("hooks deliver a saved note once, without injecting agent instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-hooks-test-"))
  try {
    const path = join(root, "config.json")
    await writeFile(path, JSON.stringify({ observer: config }))
    const runtime = await createRuntime(root, path, { YSK_DATA_DIR: join(root, "state") })
    await runtime.observer.observe(observation, provider())
    const input = {
      session_id: observation.sessionId,
      cwd: root,
      hook_event_name: "UserPromptSubmit",
    }
    const result = await handleHook(input, { host: "codex", runtime })
    assert.equal(typeof result.systemMessage, "string")
    assert.equal(result.hookSpecificOutput, undefined)
    assert.equal(result.decision, undefined)
    assert.deepEqual(await handleHook(input, { host: "codex", runtime }), {})
    assert.deepEqual(
      await handleHook(input, { host: "codex", runtime, env: { YSK_OBSERVER: "1" } }),
      {},
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("observer hooks skip subagents and recursive stop hooks", async () => {
  const input = { session_id: "s", cwd: "/unused", hook_event_name: "Stop" }
  assert.deepEqual(await handleHook({ ...input, stop_hook_active: true }, { host: "codex" }), {})
  assert.deepEqual(await handleHook({ ...input, agent_id: "child" }, { host: "codex" }), {})
  assert.deepEqual(await handleHook({ nonsense: true }, { host: "codex" }), {})
})
