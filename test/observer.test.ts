import { test } from "node:test"
import assert from "node:assert/strict"
import { Observer } from "../src/core/observer.js"
import { digest, prepareContext, redact } from "../src/core/context.js"
import { config, deferred, finding, MemoryStore, observation, provider } from "./helpers.js"
import type { ModelRequest, ModelResponse } from "../src/core/types.js"

test("a grounded consequential note is persisted and shown once per turn", async () => {
  const store = new MemoryStore()
  const observer = new Observer(store, config)
  const result = await observer.observe(observation, provider())
  assert.equal(result.status, "shown")
  assert.equal(store.state.notes.length, 1)
  assert.deepEqual(await observer.observe({ ...observation, step: 12 }, provider()), {
    status: "skipped",
    reason: "already_offered",
  })
})

test("ordinary progress can stay quiet without manufacturing a note", async () => {
  const store = new MemoryStore()
  assert.deepEqual(await new Observer(store, config).observe(observation, provider(null)), {
    status: "quiet",
    reason: "no_finding",
  })
  assert.equal(store.state.notes.length, 0)
  assert.equal(store.state.checks.length, 1)
})

test("invented quotes and unknown evidence IDs never become notes", async () => {
  for (const evidence of [
    [{ messageId: "agent-1", quote: "We ran every test and deployed successfully" }],
    [{ messageId: "missing", quote: "Every first request costs 25% more" }],
    [{ messageId: "agent-1", quote: "EVERY FIRST REQUEST COSTS 25% MORE" }],
  ]) {
    const result = await new Observer(new MemoryStore(), config).observe(
      observation,
      provider({ ...finding, evidence }),
    )
    assert.deepEqual(result, { status: "quiet", reason: "unsubstantiated" })
  }
})

test("low-confidence suggestions are discarded", async () => {
  const result = await new Observer(new MemoryStore(), config).observe(
    observation,
    provider({ ...finding, confidence: 0.6 }),
  )
  assert.deepEqual(result, { status: "quiet", reason: "low_confidence" })
})

test("malformed, oversized, and schema-invalid model responses fail quietly", async () => {
  for (const text of [
    "not JSON",
    JSON.stringify({ note: finding, execute: "rm -rf /" }),
    "x".repeat(32_001),
  ]) {
    const store = new MemoryStore()
    const observer = new Observer(store, config)
    const result = await observer.observe(observation, {
      name: "fixture",
      complete: async () => ({ text }),
    })
    assert.deepEqual(result, { status: "error", reason: "invalid_response" })
    assert.equal(store.state.notes.length, 0)
    assert.equal(store.state.sessions[digest(observation.sessionId)]?.lease, undefined)
  }
})

test("cadence, cooldown and budgets are checked before the provider is called", async () => {
  const store = new MemoryStore()
  const observer = new Observer(
    store,
    { ...config, minIntervalMs: 10_000, maxChecksPerSession: 2 },
    () => 100_000,
  )
  let calls = 0
  const model = provider(null, () => calls++)
  assert.deepEqual(await observer.observe({ ...observation, step: 1 }, model), {
    status: "skipped",
    reason: "cadence",
  })
  await observer.observe(observation, model)
  const changed = {
    ...observation,
    turnId: "turn-2",
    messages: [
      ...observation.messages,
      { id: "new", role: "assistant" as const, text: "A new detail." },
    ],
  }
  assert.deepEqual(await observer.observe(changed, model), {
    status: "skipped",
    reason: "cooldown",
  })
  await observer.observe(changed, model, true)
  assert.deepEqual(await observer.observe({ ...changed, turnId: "turn-3" }, model, true), {
    status: "skipped",
    reason: "unchanged",
  })
  assert.equal(calls, 2)
})

test("manual checks cannot bypass the project-wide hourly budget", async () => {
  const observer = new Observer(new MemoryStore(), { ...config, maxChecksPerHour: 1 })
  await observer.observe(observation, provider(null))
  const result = await observer.observe(
    { ...observation, sessionId: "second-session" },
    provider(),
    true,
  )
  assert.deepEqual(result, { status: "skipped", reason: "budget" })
})

test("parallel observers reserve one request for the same session", async () => {
  const store = new MemoryStore()
  const first = new Observer(store, config)
  const second = new Observer(store, config)
  const started = deferred<void>()
  const answer = deferred<ModelResponse>()
  const check = first.observe(observation, {
    name: "delayed",
    complete: async () => {
      started.resolve()
      return answer.promise
    },
  })
  await started.promise
  assert.deepEqual(await second.observe(observation, provider()), {
    status: "skipped",
    reason: "in_flight",
  })
  answer.resolve({ text: JSON.stringify({ note: finding }) })
  assert.equal((await check).status, "shown")
  assert.equal(store.state.checks.length, 1)
})

test("a new user turn cancels an in-flight observation and discards its result", async () => {
  const observer = new Observer(new MemoryStore(), config)
  const started = deferred<ModelRequest>()
  const answer = deferred<ModelResponse>()
  const check = observer.observe(observation, {
    name: "delayed",
    complete: async (request) => {
      started.resolve(request)
      return answer.promise
    },
  })
  const request = await started.promise
  await observer.beginTurn(observation.sessionId, "turn-2")
  assert.equal(request.signal.aborted, true)
  answer.resolve({ text: JSON.stringify({ note: finding }) })
  assert.deepEqual(await check, { status: "skipped", reason: "stale" })
  assert.equal((await observer.notes()).length, 0)
})

test("a user-only turn also invalidates a previous check", async () => {
  const observer = new Observer(new MemoryStore(), config)
  const started = deferred<void>()
  const check = observer.observe(observation, {
    name: "hanging",
    complete: async () => {
      started.resolve()
      return new Promise(() => {})
    },
  })
  await started.promise
  await observer.observe(
    { ...observation, turnId: "new", messages: [observation.messages[0]!] },
    provider(),
  )
  assert.deepEqual(await check, { status: "skipped", reason: "stale" })
})

test("timeouts release reservations even if a provider ignores cancellation", async () => {
  const store = new MemoryStore()
  const observer = new Observer(store, { ...config, timeoutMs: 25 })
  const keepAlive = setInterval(() => {}, 100)
  try {
    const result = await observer.observe(observation, {
      name: "hanging",
      complete: () => new Promise(() => {}),
    })
    assert.deepEqual(result, { status: "error", reason: "timeout" })
    assert.equal(store.state.sessions[digest(observation.sessionId)]?.lease, undefined)
  } finally {
    clearInterval(keepAlive)
  }
})

test("known topics are suppressed across sessions and included in the next prompt", async () => {
  const observer = new Observer(new MemoryStore(), config)
  const result = await observer.observe(observation, provider())
  assert.equal(result.status, "shown")
  if (result.status !== "shown") return
  await observer.feedback(result.note.id, "known")
  const next = await observer.observe(
    { ...observation, sessionId: "other" },
    provider(
      { ...finding, summary: "A differently worded observation about the same cost." },
      (request) => {
        assert.ok(request.prompt.includes(finding.topic))
      },
    ),
  )
  assert.deepEqual(next, { status: "quiet", reason: "duplicate" })
})

test("topics remain isolated between projects", async () => {
  const a = new Observer(new MemoryStore(), config)
  const b = new Observer(new MemoryStore(), config)
  assert.equal((await a.observe(observation, provider())).status, "shown")
  assert.equal((await b.observe(observation, provider())).status, "shown")
})

test("concurrent sessions cannot publish the same topic twice", async () => {
  const store = new MemoryStore()
  const result = await Promise.all([
    new Observer(store, config).observe(observation, provider()),
    new Observer(store, config).observe({ ...observation, sessionId: "other" }, provider()),
  ])
  assert.equal(result.filter((item) => item.status === "shown").length, 1)
  assert.equal(store.state.notes.length, 1)
})

test("pausing aborts pending checks and resuming works", async () => {
  const observer = new Observer(new MemoryStore(), config)
  await observer.pause(true)
  assert.deepEqual(await observer.observe(observation, provider(), true), {
    status: "skipped",
    reason: "paused",
  })
  await observer.pause(false)
  assert.equal((await observer.observe(observation, provider())).status, "shown")
  observer.dispose()
  assert.deepEqual(await observer.observe(observation, provider()), {
    status: "skipped",
    reason: "disposed",
  })
})

test("notification delivery is atomic and does not call the model", async () => {
  const observer = new Observer(new MemoryStore(), config)
  await observer.observe(observation, provider())
  const delivered = await Promise.all([
    observer.notifications("session-1"),
    observer.notifications("session-1"),
  ])
  assert.equal(delivered.flat().length, 1)
})

test("notification delivery expires old notes even without a new observation", async () => {
  let now = 100_000
  const observer = new Observer(new MemoryStore(), config, () => now)
  await observer.observe(observation, provider())
  now += 31 * 86_400_000
  assert.deepEqual(await observer.notifications(observation.sessionId), [])
})

test("pausing an active check releases its lease", async () => {
  const store = new MemoryStore()
  const observer = new Observer(store, config)
  const started = deferred<void>()
  const check = observer.observe(observation, {
    name: "waiting",
    complete: () => {
      started.resolve()
      return new Promise(() => {})
    },
  })
  await started.promise
  await observer.pause(true)
  await check
  assert.equal(store.state.sessions[digest(observation.sessionId)]?.lease, undefined)
})

test("untrusted session identifiers cannot alter object prototypes", async () => {
  const store = new MemoryStore()
  const observer = new Observer(store, config)
  assert.equal(
    (await observer.observe({ ...observation, sessionId: "__proto__" }, provider())).status,
    "shown",
  )
  assert.equal(Object.getPrototypeOf(store.state.sessions), Object.prototype)
  assert.equal(({} as { turnId?: string }).turnId, undefined)
})

test("context truncation respects the budget and retains the user's latest goal", () => {
  const messages = prepareContext(
    [
      { id: "old", role: "tool", text: "old".repeat(40_000) },
      { id: "user", role: "user", text: "Latest goal ".repeat(2_000) },
      { id: "agent", role: "assistant", text: "result".repeat(3_000) },
    ],
    { ...config, maxContextChars: 2_000, maxMessageChars: 6_000 },
  )
  assert.ok(messages.some((message) => message.id === "user"))
  assert.ok(messages.reduce((sum, message) => sum + message.text.length, 0) <= 2_000)
})

test("common credentials are removed before any provider sees the context", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
  const observer = new Observer(new MemoryStore(), config)
  await observer.observe(
    {
      ...observation,
      messages: [
        ...observation.messages,
        { id: "secret", role: "tool", text: `Authorization: Bearer ${secret}\nAPI_KEY=${secret}` },
      ],
    },
    provider(null, (request) => {
      assert.equal(request.prompt.includes(secret), false)
      assert.ok(request.prompt.includes("[redacted"))
    }),
  )
  assert.equal(redact("\u001b[31mhello\u001b[0m\u202eevil"), "helloevil")
})

test("duplicate message identifiers are rejected before inference", async () => {
  await assert.rejects(
    new Observer(new MemoryStore(), config).observe(
      { ...observation, messages: [observation.messages[0]!, observation.messages[0]!] },
      provider(),
    ),
    /Message IDs must be unique/,
  )
})
