import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { version } = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
const temporary = await mkdtemp(join(tmpdir(), "ysk-package-"))
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const run = (command, args, cwd = temporary, env = process.env) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  })

try {
  const packed = JSON.parse(
    run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], project),
  )[0]
  assert.ok(packed.files.some((file) => file.path === "dist/gui-experimental.cjs"))
  assert.ok(packed.files.every((file) => !/^(?:test|src|\.work|node_modules)\//.test(file.path)))
  const consumer = join(temporary, "consumer with spaces")
  await mkdir(consumer)
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(
    npm,
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporary, packed.filename),
    ],
    consumer,
  )
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(temporary, "config"),
    YSK_DATA_DIR: join(temporary, "state"),
  }
  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ysk.cmd" : "ysk",
  )
  const cli = (args, input) =>
    execFileSync(process.platform === "win32" ? `"${bin}"` : bin, args, {
      cwd: consumer,
      env,
      input,
      encoding: "utf8",
      timeout: 15_000,
      shell: process.platform === "win32",
    })
  assert.equal(cli(["--version"]).trim(), version)
  assert.deepEqual(JSON.parse(cli(["notes", "--json"])), [])
  assert.equal(cli(["hook", "--host", "codex"], "invalid JSON").trim(), "{}")
  const imports = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import plugin from '@polanski13/you-should-know';
    import tui from '@polanski13/you-should-know/tui';
    import { YouShouldKnow } from '@polanski13/you-should-know/rpc';
    import * as core from '@polanski13/you-should-know/core';
    console.log(JSON.stringify([plugin.id, tui.id, YouShouldKnow.id, typeof core.Observer]));
  `,
    ],
    consumer,
    env,
  )
  assert.deepEqual(JSON.parse(imports), [
    "you-should-know",
    "you-should-know-tui",
    "you-should-know",
    "function",
  ])
  const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"))
  assert.equal(lock.packages["node_modules/@opencode/plugin"], undefined)
  console.log(
    `Package smoke passed: installed CLI, hooks and all Node exports; ${packed.files.length} files, ${Math.ceil(packed.size / 1024)} KB packed.`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
