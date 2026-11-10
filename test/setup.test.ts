import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse } from "jsonc-parser"
import { installOpenCode } from "../src/setup/opencode.js"
import { installLauncher, pathBlock } from "../src/setup/launcher.js"
import { mergeHooks } from "../src/adapters/install.js"
import { PACKAGE_NAME } from "../src/version.js"
import { parseTargets } from "../src/setup/index.js"

test("OpenCode setup preserves JSONC comments, other plugins and existing observer options", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-setup-test-"))
  try {
    const old = join(root, "old source")
    await mkdir(old)
    await writeFile(join(old, "package.json"), JSON.stringify({ name: PACKAGE_NAME }))
    const path = join(root, "opencode.jsonc")
    const original = `// My configuration\n{\n  "model": "my/model", // Keep this comment\n  "plugins": [\n    "another-plugin",\n    { "package": ${JSON.stringify(old)}, "options": { "language": "ru", "maxChecksPerHour": 2 } },\n  ],\n}\n`
    await writeFile(path, original)
    const next = join(root, "release app")
    await installOpenCode({ path, packagePath: next })
    const installed = await readFile(path, "utf8")
    assert.ok(installed.includes("// My configuration"))
    assert.ok(installed.includes("// Keep this comment"))
    assert.deepEqual(parse(installed), {
      model: "my/model",
      plugins: [
        "another-plugin",
        { package: next, options: { language: "ru", maxChecksPerHour: 2 } },
      ],
    })
    assert.equal(await readFile(`${path}.before-ysk`, "utf8"), original)
    assert.equal(await installOpenCode({ path, packagePath: next }), false)
    await installOpenCode({ path, packagePath: next, remove: true })
    assert.deepEqual(parse(await readFile(path, "utf8")), {
      model: "my/model",
      plugins: ["another-plugin"],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("OpenCode setup refuses malformed configuration without changing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-setup-test-"))
  try {
    const path = join(root, "opencode.jsonc")
    for (const text of ['{"plugins": [broken]}', '{"plugins": "custom"}']) {
      await writeFile(path, text)
      await assert.rejects(installOpenCode({ path, packagePath: root }), /no changes/)
      assert.equal(await readFile(path, "utf8"), text)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("OpenCode setup appends once and removes duplicate managed entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-setup-test-"))
  try {
    const path = join(root, "opencode.json")
    await writeFile(
      path,
      JSON.stringify({ plugins: [PACKAGE_NAME, `${PACKAGE_NAME}@0.1.0`, "other"] }),
    )
    await installOpenCode({ path, packagePath: root })
    assert.deepEqual(parse(await readFile(path, "utf8")).plugins, [root, "other"])
    assert.equal(await installOpenCode({ path, packagePath: root }), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("PATH setup is idempotent and preserves existing shell commands", () => {
  const original = "export CUSTOM=value\n"
  const path = "/some path/it's/bin"
  const next = pathBlock(original, path)
  assert.equal(pathBlock(next, path), next)
  assert.ok(next.startsWith(original))
  const moved = pathBlock(next, "/new/bin")
  assert.equal(moved.includes("some path"), false)
  assert.equal(moved.split("# >>> You Should Know >>>").length, 2)
  assert.throws(() => pathBlock("# >>> You Should Know >>>\nunfinished", path), /preserved/)
})

test("managed hooks use an absolute bundled runtime instead of relying on PATH", () => {
  const result = mergeHooks(
    {},
    "codex",
    "/install with spaces/app/cli.js",
    false,
    "/private runtime/node",
  )
  const text = JSON.stringify(result)
  assert.ok(text.includes("/private runtime/node"))
  assert.ok(text.includes("commandWindows"))
  assert.equal(text.includes('"command":"node '), false)
})

test("setup client selection supports explicit multiple targets and rejects typos", () => {
  assert.deepEqual(parseTargets("opencode,codex,opencode"), ["opencode", "codex"])
  assert.throws(() => parseTargets("open-code"), /Choose/)
})

test("launcher upgrades replace owned launchers and preserve unrelated commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-launcher-test-"))
  try {
    const env = { ...process.env, YSK_BIN_DIR: join(root, "bin") }
    const options = {
      root,
      env,
      nodePath: process.execPath,
      cliPath: join(root, "old", "cli.js"),
      configurePath: false,
    }
    const path = await installLauncher(options)
    await installLauncher({ ...options, cliPath: join(root, "new", "cli.js") })
    assert.ok((await readFile(path, "utf8")).includes(join(root, "new", "cli.js")))
    const unrelated = "echo another command\n"
    await writeFile(path, unrelated)
    await assert.rejects(installLauncher(options), /Another program already owns/)
    assert.equal(await readFile(path, "utf8"), unrelated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
