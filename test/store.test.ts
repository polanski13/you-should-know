import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileStore } from "../src/core/store.js"

test("independent stores serialize updates without dropping writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-store-test-"))
  try {
    const a = await FileStore.create(root, root)
    const b = await FileStore.create(root, root)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).transact((state) => {
          state.checks.push(i)
        }),
      ),
    )
    assert.equal(await a.transact((state) => state.checks.length), 20)
    const files = await readdir(a.directory)
    assert.equal(
      files.some((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
      false,
    )
    if (process.platform !== "win32")
      assert.equal((await stat(join(a.directory, "state.json"))).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt or newer state is preserved rather than silently reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-store-test-"))
  try {
    const store = await FileStore.create(root, root)
    const path = join(store.directory, "state.json")
    for (const content of ["{broken", '{"version":2,"important":"keep me"}']) {
      await writeFile(path, content)
      await assert.rejects(
        store.transact((state) => {
          state.notes = []
        }),
        /existing file was preserved/,
      )
      assert.equal(await readFile(path, "utf8"), content)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("project paths do not leak into filenames and different workspaces stay separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-store-test-"))
  try {
    const a = await FileStore.create(root, join(root, "private project"))
    const b = await FileStore.create(root, join(root, "私有项目"))
    assert.notEqual(a.directory, b.directory)
    assert.equal(a.directory.includes("private project"), false)
    await a.transact((state) => {
      state.paused = true
    })
    assert.equal(await b.transact((state) => state.paused), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
