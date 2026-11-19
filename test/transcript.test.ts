import assert from "node:assert/strict"
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readTranscript } from "../src/adapters/transcript.js"
import { handleHook } from "../src/adapters/hooks.js"
import { createRuntime } from "../src/runtime.js"
import { digest } from "../src/core/context.js"
import { provider } from "./helpers.js"

const line = (value: unknown) => JSON.stringify(value) + "\n"
const user = (id: string, text: string) =>
  line({ uuid: id, message: { role: "user", content: text } })
const tool = (id: string, text: string) =>
  line({ uuid: id, message: { role: "user", content: [{ type: "tool_result", content: text }] } })
const padding = "回".repeat(3500)
const logs = (count: number) =>
  Array.from({ length: count }, (_, i) => tool("t" + i, padding + i)).join("")

test("long transcripts recover the user and the complete step count across appends, truncation and rotation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-transcript-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const history = logs(270)
  await writeFile(path, user("u", "Проверить финальный отчёт") + history)
  const first = await readTranscript(path)
  assert.ok(first.cursor.offset > 700_000)
  assert.equal(first.messages[0]?.text, "Проверить финальный отчёт")
  assert.equal(first.steps, 270)
  assert.ok(!JSON.stringify(first.cursor).includes("Проверить"))
  const partial = tool("last", "Тест провален")
  await appendFile(path, partial.slice(0, -6))
  const midway = await readTranscript(path, first.cursor)
  assert.equal(midway.steps, 270)
  await appendFile(path, partial.slice(-6))
  const appended = await readTranscript(path, midway.cursor)
  assert.equal(appended.messages.at(-1)?.text, "Тест провален")
  assert.equal(appended.steps, 271)
  assert.deepEqual(appended, await readTranscript(path))
  // Rewrite the same inode and grow past its old length.
  await writeFile(
    path,
    user("v", "Second goal after rewrite") + history + tool("extra", "New data".repeat(90)),
  )
  const rewritten = await readTranscript(path, appended.cursor)
  assert.equal(rewritten.messages[0]?.id, "v")
  assert.equal(rewritten.steps, 271)
  await writeFile(path, user("short", "Short file"))
  const shortened = await readTranscript(path, rewritten.cursor)
  assert.equal(shortened.messages[0]?.text, "Short file")
  assert.equal(shortened.steps, 0)
  await writeFile(join(dir, "next"), user("new", "Third goal") + history)
  await rename(join(dir, "next"), path)
  const rotated = await readTranscript(path, shortened.cursor)
  assert.equal(rotated.turnId, "new")
  assert.equal(rotated.messages[0]?.text, "Third goal")
  assert.equal(rotated.steps, 270)
})

test("a multi-megabyte JSONL record retains the verdict and an unknown oversized row cannot inherit another goal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-record-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  await writeFile(
    path,
    user("u", "Verify the report") +
      tool("log", "begin\n" + "line\n".repeat(470_000) + "Final: 2 failed"),
  )
  const long = await readTranscript(path)
  assert.equal(long.messages[0]?.id, "u")
  assert.ok(long.messages.at(-1)?.text.endsWith("Final: 2 failed"))
  assert.equal(long.steps, 1)
  await appendFile(path, tool("huge", ".".repeat(8_100_000)))
  const unknown = await readTranscript(path, long.cursor)
  assert.deepEqual(unknown.messages, [])
  await appendFile(path, user("next", "New prompt") + tool("done", "Ready"))
  const resumed = await readTranscript(path, unknown.cursor)
  assert.equal(resumed.turnId, "next")
  assert.equal(resumed.steps, 1)
})

test("parallel hook processes observe a goal beyond the tail exactly once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-hook-index-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const config = join(dir, "config.json")
  await writeFile(config, JSON.stringify({ observer: { minSteps: 6, minIntervalMs: 0 } }))
  const env = { YSK_DATA_DIR: join(dir, "state") }
  const runtimes = await Promise.all([
    createRuntime(dir, config, env),
    createRuntime(dir, config, env),
  ])
  const prompts: string[] = []
  for (const runtime of runtimes)
    runtime.provider = provider(null, (req) => prompts.push(req.prompt))
  const event = { cwd: dir, session_id: "s", prompt_id: "p", transcript_path: path }
  await handleHook(
    { ...event, hook_event_name: "UserPromptSubmit" },
    { host: "claude-code", runtime: runtimes[0]! },
  )
  await writeFile(path, user("u", "Never lose this goal") + logs(5))
  await handleHook(
    { ...event, hook_event_name: "PostToolUse" },
    { host: "claude-code", runtime: runtimes[0]! },
  )
  await appendFile(path, tool("t5", "progress\n".repeat(300_000) + "Final: 2 failed"))
  await Promise.all(
    runtimes.map((runtime) =>
      handleHook({ ...event, hook_event_name: "Stop" }, { host: "claude-code", runtime }),
    ),
  )
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0]!.includes("Never lose this goal"))
  assert.ok(prompts[0]!.includes("Final: 2 failed"))
  const saved = await runtimes[0]!.store.transact((s) => s.sessions[digest("s")]!)
  assert.equal(saved.checks, 1)
  assert.ok(saved.transcript?.user)
  assert.ok(!JSON.stringify(saved).includes("Never lose this goal"))
})

test("a new turn marker without its user message never borrows an earlier goal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-turn-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const marker = (id: string) => line({ type: "turn_context", payload: { turn_id: id } })
  await writeFile(
    path,
    marker("old") +
      line({ type: "response_item", payload: { role: "user", content: "old goal" } }) +
      marker("new"),
  )
  const batch = await readTranscript(path)
  assert.equal(batch.turnId, "new")
  assert.deepEqual(batch.messages, [])
})
