import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { parse } from "jsonc-parser"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { downloadRuntime } from "./runtime.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { version } = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
const temporary = await realpath(await mkdtemp(join(tmpdir(), "ysk-release-")))
const run = promisify(execFile)
let server
let client
try {
  const home = join(temporary, "home with spaces")
  const root = join(home, "you-should-know")
  const bin = join(home, "bin")
  const payload = join(temporary, "payload")
  const nodeName = process.platform === "win32" ? "node.exe" : "node"
  await mkdir(join(payload, "runtime"), { recursive: true })
  await cp(join(project, "release/app"), join(payload, "app"), { recursive: true })
  await writeFile(join(payload, "VERSION"), `${version}\n`)
  const platform = process.platform === "win32" ? "windows" : process.platform
  await downloadRuntime(`${platform}-${process.arch}`, join(payload, "runtime"))
  const asset = `you-should-know-${platform}-${process.arch}.tar.gz`
  const archive = join(temporary, asset)
  execFileSync("tar", ["-czf", archive, "-C", payload, "app", "runtime", "VERSION"], {
    stdio: "pipe",
  })
  const bytes = await readFile(archive)
  const hash = createHash("sha256").update(bytes).digest("hex")
  let validChecksum = false
  server = createServer((request, response) => {
    if (request.url === `/${asset}`) {
      response.end(bytes)
      return
    }
    if (request.url === "/SHA256SUMS") {
      response.end(`${validChecksum ? hash : "0".repeat(64)}  ${asset}\n`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SHELL: "/bin/sh",
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    YSK_DATA_DIR: join(home, "state"),
    YSK_INSTALL_DIR: root,
    YSK_BIN_DIR: bin,
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    YSK_RELEASE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    YSK_VERSION: version,
  }
  const config = join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
  await mkdir(dirname(config), { recursive: true })
  const original = '// Keep my settings\n{ "model": "my/model", "plugins": ["other-plugin"] }\n'
  await writeFile(config, original)
  const install = (target = "opencode") =>
    process.platform === "win32"
      ? run(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(project, "install.ps1"),
            ...(target ? ["-Client", target] : []),
            "-NoPath",
          ],
          { env, timeout: 90_000 },
        )
      : run(
          "sh",
          [join(project, "install.sh"), ...(target ? ["--host", target] : []), "--no-path"],
          { env, timeout: 90_000 },
        )
  await assert.rejects(install(), /checksum mismatch/)
  assert.equal(await readFile(config, "utf8"), original)
  validChecksum = true
  await install()
  const app = join(root, "versions", version, "app")
  const node = join(root, "versions", version, "runtime", nodeName)
  const cli = join(app, "cli.js")
  assert.equal((await run(node, [cli, "--version"], { env })).stdout.trim(), version)
  const installed = await readFile(config, "utf8")
  assert.ok(installed.includes("// Keep my settings"))
  assert.deepEqual(parse(installed), {
    model: "my/model",
    plugins: ["other-plugin", { package: app, options: { language: "auto" } }],
  })
  await install()
  assert.equal(await readFile(config, "utf8"), installed)
  const launcher = join(bin, process.platform === "win32" ? "ysk.cmd" : "ysk")
  const launched = await run(
    process.platform === "win32" ? `"${launcher}"` : launcher,
    ["--version"],
    { env, shell: process.platform === "win32" },
  )
  assert.equal(launched.stdout.trim(), version)
  await run(
    node,
    [
      "--input-type=module",
      "-e",
      "await import('./server.js'); await import('./tui.js'); await import('./rpc.js');",
    ],
    { cwd: app, env },
  )
  await run(node, [cli, "setup", "--install-root", root, "--no-path"], { env })
  const transport = new StdioClientTransport({
    command: node,
    args: [cli, "mcp", "--cwd", home],
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
  })
  client = new Client({ name: "release-smoke", version: "1.0.0" })
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length, 3)
  const notes = await client.callTool({ name: "ysk_notes", arguments: {} })
  assert.equal(notes.isError, undefined)
  await client.close()
  client = undefined
  const oldApp = join(root, "versions", "0.1.0", "app")
  await mkdir(oldApp, { recursive: true })
  await writeFile(
    join(oldApp, "package.json"),
    JSON.stringify({ name: "@polanski13/you-should-know", version: "0.1.0" }),
  )
  await writeFile(join(oldApp, "keep.txt"), "An old session still uses this version.")
  await writeFile(
    config,
    `// Keep my settings\n${JSON.stringify({ model: "my/model", plugins: ["other-plugin", { package: oldApp, options: { language: "ru", maxChecksPerHour: 2 } }] })}\n`,
  )
  const receipt = join(root, "installation.json")
  await writeFile(
    receipt,
    JSON.stringify({
      version: "0.1.0",
      targets: ["opencode", "claude-code"],
      packagePath: oldApp,
      launcher,
    }),
  )
  const providerConfig = join(env.XDG_CONFIG_HOME, "you-should-know", "config.json")
  await mkdir(dirname(providerConfig), { recursive: true })
  await writeFile(
    providerConfig,
    JSON.stringify({ provider: { type: "anthropic", model: "smoke-test" } }),
  )
  const hooksPath = join(env.CLAUDE_CONFIG_DIR, "settings.json")
  await mkdir(dirname(hooksPath), { recursive: true })
  const unrelated = { type: "command", command: "echo keep-hook" }
  await writeFile(hooksPath, JSON.stringify({ hooks: { PostToolUse: [{ hooks: [unrelated] }] } }))
  await install(null)
  assert.deepEqual(parse(await readFile(config, "utf8")).plugins, [
    "other-plugin",
    { package: app, options: { language: "ru", maxChecksPerHour: 2 } },
  ])
  assert.ok((await readFile(config, "utf8")).includes("// Keep my settings"))
  assert.equal(
    await readFile(join(oldApp, "keep.txt"), "utf8"),
    "An old session still uses this version.",
  )
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).targets, ["opencode", "claude-code"])
  const upgradedHooks = JSON.parse(await readFile(hooksPath, "utf8"))
  assert.deepEqual(upgradedHooks.hooks.PostToolUse[0].hooks, [unrelated])
  assert.ok(
    upgradedHooks.hooks.PostToolUse[1].hooks[0].command.includes(node.replaceAll("\\", "/")),
  )
  await run(node, [cli, "uninstall", "claude-code"], { env })
  await install(null)
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).targets, ["opencode"])
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")).hooks, {
    PostToolUse: [{ hooks: [unrelated] }],
  })
  await run(node, [cli, "uninstall", "opencode"], { env })
  assert.deepEqual(parse(await readFile(config, "utf8")).plugins, ["other-plugin"])
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).targets, [])
  console.log(
    `Release smoke passed (${platform}/${process.arch}): checksum rejection, fresh/repeat install, saved-target upgrades, settings preservation, disconnect, bundled runtime, launcher, OpenCode exports and MCP.`,
  )
} finally {
  await client?.close()
  server?.closeAllConnections()
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
