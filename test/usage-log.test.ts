import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "../src/runtime.js"
import { observation, provider } from "./helpers.js"

test("local usage logging groups attempts, omits message text and distinguishes missing counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-usage-"))
  try {
    const path = join(root, "usage.jsonl")
    await writeFile(path, "")
    if (process.platform !== "win32") await chmod(path, 0o644)
    const env = { YSK_USAGE_LOG: path, YSK_DATA_DIR: join(root, "state"), XDG_CONFIG_HOME: root }
    const { observer } = await createRuntime(root, undefined, env)
    await observer.observe({ ...observation, step: 1 }, provider())
    await observer.observe(observation, {
      name: "fixture",
      complete: async () => ({
        text: '{"note":null}',
        model: "served",
        usage: { inputTokens: 30, outputTokens: 5 },
      }),
    })
    await observer.observe(
      {
        ...observation,
        turnId: "another",
        messages: [...observation.messages, { id: "b", role: "tool", text: "Transport recovered" }],
      },
      {
        name: "fixture",
        complete: async () => {
          throw new Error("private error detail")
        },
      },
      true,
    )
    const content = await readFile(path, "utf8")
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600)
    const [first, second, ...rest] = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.equal(rest.length, 0)
    assert.equal(first.session, second.session)
    assert.notEqual(first.turn, second.turn)
    assert.equal(first.model, "served")
    assert.equal(first.reason, "no_finding")
    assert.deepEqual(first.usage, { inputTokens: 30, outputTokens: 5 })
    assert.equal(second.reason, "provider_error")
    assert.equal(second.usage, undefined)
    for (const value of [
      root,
      observation.sessionId,
      observation.turnId,
      ...observation.messages.map((message) => message.text),
      "Transport recovered",
      "private error detail",
    ]) {
      assert.ok(!content.includes(value))
    }
    const missingDirectory = await createRuntime(root, undefined, {
      ...env,
      YSK_USAGE_LOG: join(root, "missing", "log"),
    })
    assert.equal(
      (
        await missingDirectory.observer.observe(
          { ...observation, sessionId: "new" },
          provider(null),
          true,
        )
      ).status,
      "quiet",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("aliases of one workspace share a project identity in state and usage records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-usage-alias-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const real = join(dir, "project"),
    alias = join(dir, "alias")
  await mkdir(real)
  await symlink(real, alias, process.platform === "win32" ? "junction" : "dir")
  const env = {
    YSK_DATA_DIR: join(dir, "state"),
    XDG_CONFIG_HOME: dir,
    YSK_USAGE_LOG: join(dir, "usage.jsonl"),
  }
  const a = await createRuntime(real, undefined, env),
    b = await createRuntime(alias, undefined, env)
  await a.observer.observe(observation, provider(null), true)
  await b.observer.observe({ ...observation, sessionId: "another-session" }, provider(null), true)
  const ids = (await readFile(env.YSK_USAGE_LOG, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).project)
  assert.deepEqual(ids, [a.store.project, a.store.project])
  assert.equal(a.store.directory, b.store.directory)
})
