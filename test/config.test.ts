import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, observerOverrides } from "../src/core/config.js"

test("project and plugin overrides preserve unspecified global settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-config-test-"))
  try {
    const configPath = join(root, "global.json")
    await writeFile(
      configPath,
      JSON.stringify({
        observer: { enabled: false, minSteps: 12, language: "ru", maxChecksPerHour: 2 },
      }),
    )
    const global = await loadConfig({ workspace: root, configPath })
    assert.equal(global.observer.enabled, false)
    assert.equal(global.observer.minSteps, 12)
    await writeFile(join(root, ".you-should-know.json"), JSON.stringify({ language: "zh" }))
    const project = await loadConfig({ workspace: root, configPath })
    assert.equal(project.observer.enabled, false)
    assert.equal(project.observer.minSteps, 12)
    assert.equal(project.observer.language, "zh")
    assert.deepEqual(observerOverrides({}), {})
    assert.deepEqual(
      { ...project.observer, ...observerOverrides({ minSteps: 8 }) },
      { ...project.observer, minSteps: 8 },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("projects cannot select an executable, endpoint or credential source", () => {
  for (const value of [
    { provider: { executable: "other" } },
    { executable: "other" },
    { baseUrl: "https://example.com" },
    { minSteps: 0 },
  ]) {
    assert.throws(() => observerOverrides(value))
  }
})
