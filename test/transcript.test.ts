import assert from "node:assert/strict"
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseTranscript, readTranscript } from "../src/adapters/transcript.js"
import { handleHook } from "../src/adapters/hooks.js"
import { createRuntime } from "../src/runtime.js"
import { digest } from "../src/core/context.js"
import { deferred, provider } from "./helpers.js"

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
  const current = line({
    type: "response_item",
    payload: { role: "user", content: "current goal" },
  })
  await appendFile(path, current)
  const continued = await readTranscript(path, batch.cursor)
  assert.deepEqual(
    continued.messages.map((m) => m.text),
    ["current goal"],
  )
  assert.deepEqual(
    parseTranscript(
      user("old", "old goal") + tool("t", "old evidence") + user("new", "current goal"),
    ).messages.map((m) => m.text),
    ["current goal"],
  )
})
test("a native Stop payload supplies the final text once for its own prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-native-stop-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const config = join(dir, "config.json")
  await writeFile(config, JSON.stringify({ observer: { minSteps: 1, minIntervalMs: 0 } }))
  const runtime = await createRuntime(dir, config, { YSK_DATA_DIR: join(dir, "state") })
  const captured: string[] = []
  runtime.provider = provider(null, (req) => captured.push(req.prompt))
  const event = { cwd: dir, session_id: "s", prompt_id: "p", transcript_path: path }
  const stop = {
    ...event,
    hook_event_name: "Stop",
    last_assistant_message: "All checks completed.",
  }
  const goal = (p: string) =>
    line({ uuid: "u-" + p, promptId: p, message: { role: "user", content: "Verify the build" } })
  const options = { host: "claude-code" as const, runtime }
  await handleHook({ ...event, hook_event_name: "UserPromptSubmit" }, options)
  await writeFile(path, goal("previous") + tool("t0", "Old warning"))
  await handleHook(stop, options)
  assert.equal(captured.length, 0)
  await appendFile(path, goal("p") + tool("t1", "Two tests failed"))
  await handleHook(stop, options)
  assert.match(captured[0]!, /All checks completed\./)
  const flushed = line({
    uuid: "final",
    message: { role: "assistant", content: stop.last_assistant_message },
  })
  await appendFile(path, tool("t2", "One more test") + flushed)
  await handleHook(stop, options)
  assert.equal(captured.length, 1)
  const next = { ...event, prompt_id: "q" }
  await handleHook({ ...next, hook_event_name: "UserPromptSubmit" }, options)
  await appendFile(path, goal("q") + tool("t3", "New test") + flushed)
  await handleHook({ ...stop, prompt_id: "q" }, options)
  assert.equal(captured.length, 2)
  assert.equal(captured[1]!.split(stop.last_assistant_message).length - 1, 1)
})
test("identical parallel results at the same timestamp still reach the observer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-parallel-outputs-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const config = join(dir, "config.json")
  await writeFile(config, JSON.stringify({ observer: { minSteps: 2 } }))
  const runtime = await createRuntime(dir, config, { YSK_DATA_DIR: join(dir, "state") })
  let calls = 0
  runtime.provider = provider(null, () => calls++)
  const timestamp = "2026-05-10T10:00:00.000Z"
  const output = (call_id: string) =>
    line({
      type: "response_item",
      timestamp,
      payload: { type: "function_call_output", call_id, output: "Finished" },
    })
  await writeFile(
    path,
    line({ type: "turn_context", payload: { turn_id: "turn" } }) +
      line({
        type: "response_item",
        timestamp,
        payload: { role: "user", content: "Check both jobs" },
      }) +
      output("one") +
      output("two"),
  )
  const first = await readTranscript(path)
  assert.equal(new Set(first.messages.map((m) => m.id)).size, 3)
  assert.deepEqual((await readTranscript(path, first.cursor)).messages, first.messages)
  await handleHook(
    {
      session_id: "s",
      turn_id: "turn",
      cwd: dir,
      transcript_path: path,
      hook_event_name: "Stop",
    },
    { host: "codex", runtime },
  )
  assert.equal(calls, 1)
})
test("a rewritten line deep in a growing prefix invalidates the saved goal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-prefix-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  const source = user("original", "Initial goal") + logs(310)
  await writeFile(path, source)
  const first = await readTranscript(path)
  const lines = source.trimEnd().split("\n")
  assert.ok(Buffer.byteLength(lines.slice(0, 43).join("\n")) < first.cursor.offset)
  lines[42] = lines[42]!.replace('"type":"tool_result"', '"type":"other_event"')
  await writeFile(path, lines.join("\n") + "\n" + tool("end", "One more result"))
  const resumed = await readTranscript(path, first.cursor)
  assert.equal(resumed.turnId, "t41")
  assert.equal(resumed.steps, 269)
  assert.deepEqual(resumed, await readTranscript(path))
})

test("malformed complete records fence off their unknown turn and invalid hook IDs preserve state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-unknown-turn-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl")
  await writeFile(path, user("old", "First goal") + "{broken}\n" + tool("t1", "New evidence"))
  const invalid = await readTranscript(path)
  assert.deepEqual(invalid.messages, [])
  await appendFile(path, user("next", "Second goal") + tool("t2", "Ready"))
  assert.equal((await readTranscript(path, invalid.cursor)).turnId, "next")
  const runtime = await createRuntime(dir, undefined, {
    YSK_DATA_DIR: join(dir, "state"),
    XDG_CONFIG_HOME: dir,
  })
  const submit = { session_id: "s", cwd: dir, hook_event_name: "UserPromptSubmit" }
  await handleHook({ ...submit, turn_id: "valid" }, { host: "codex", runtime })
  await handleHook({ ...submit, turn_id: "x".repeat(500) }, { host: "codex", runtime })
  assert.equal(
    await runtime.store.transact((s) => s.sessions[digest("s")]?.activeHookPrompt),
    "valid",
  )
})
test("a native final reply waits for an active tool check and spends at most one extra check", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-final-lease-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "chat.jsonl"),
    cfg = join(dir, "config.json")
  await writeFile(
    cfg,
    JSON.stringify({ observer: { minSteps: 2, minIntervalMs: 60_000, maxChecksPerSession: 2 } }),
  )
  await writeFile(
    path,
    line({ uuid: "user", promptId: "p", message: { role: "user", content: "Check both jobs" } }) +
      tool("a", "First failed") +
      tool("b", "Second failed"),
  )
  const env = { YSK_DATA_DIR: join(dir, "state") }
  const [toolHost, finalHost] = await Promise.all([
    createRuntime(dir, cfg, env),
    createRuntime(dir, cfg, env),
  ])
  const firstStarted = deferred<void>(),
    finishTool = deferred<void>(),
    finalWaiting = deferred<void>()
  toolHost.provider = {
    name: "fixture",
    complete: async () => {
      firstStarted.resolve()
      await finishTool.promise
      return { text: '{"note":null}' }
    },
  }
  const stopObserve = finalHost.observer.observe.bind(finalHost.observer)
  finalHost.observer.observe = async (...args) => {
    const r = await stopObserve(...args)
    if (r.status === "skipped" && r.reason === "in_flight") finalWaiting.resolve()
    return r
  }
  const seen: string[] = []
  finalHost.provider = provider(null, (req) => seen.push(req.prompt))
  const event = { cwd: dir, session_id: "s", prompt_id: "p", transcript_path: path }
  const opts = { host: "claude-code" as const, runtime: finalHost }
  await handleHook({ ...event, hook_event_name: "UserPromptSubmit" }, opts)
  const running = handleHook(
    { ...event, hook_event_name: "PostToolUse" },
    { ...opts, runtime: toolHost },
  )
  await firstStarted.promise
  const stop = { ...event, hook_event_name: "Stop", last_assistant_message: "Both jobs passed." }
  const pending = handleHook(stop, opts)
  await finalWaiting.promise
  assert.equal(seen.length, 0)
  finishTool.resolve()
  await Promise.all([running, pending])
  await handleHook(stop, opts)
  assert.equal(seen.length, 1)
  assert.match(seen[0]!, /Both jobs passed\./)
  assert.equal(await finalHost.store.transact((s) => s.checks.length), 2)
})
