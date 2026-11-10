import { build } from "esbuild"
import { builtinModules } from "node:module"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { downloadRuntime, nodeVersion, platforms } from "./runtime.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const output = join(project, "release")
const app = join(output, "app")
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
const { values } = parseArgs({
  options: { archives: { type: "boolean" }, platform: { type: "string" } },
})
if (values.platform && !platforms.includes(values.platform))
  throw new Error("Unsupported release platform")
await rm(app, { recursive: true, force: true })
await mkdir(app, { recursive: true })
const result = await build({
  absWorkingDir: project,
  entryPoints: {
    cli: "src/cli.ts",
    server: "src/opencode/index.ts",
    tui: "src/opencode/tui.ts",
    rpc: "src/opencode/rpc.ts",
    core: "src/core/index.ts",
  },
  outdir: app,
  bundle: true,
  packages: "bundle",
  mainFields: ["module", "main"],
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  legalComments: "external",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
})
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
for (const entry of Object.values(result.metafile.outputs)) {
  for (const imported of entry.imports) {
    if (imported.external && !builtins.has(imported.path))
      throw new Error(`Unbundled runtime dependency: ${imported.path}`)
  }
}
await writeFile(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      type: "module",
      license: manifest.license,
      exports: {
        ".": "./server.js",
        "./tui": "./tui.js",
        "./rpc": "./rpc.js",
        "./core": "./core.js",
        "./gui-experimental": "./gui-experimental.cjs",
      },
    },
    null,
    2,
  )}\n`,
)
await copyFile(join(project, "dist/gui-experimental.cjs"), join(app, "gui-experimental.cjs"))
for (const name of ["LICENSE", "README.md", "README.ru.md", "README.zh-CN.md"])
  await copyFile(join(project, name), join(app, name))
const packages = new Set()
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue
  let directory = dirname(resolve(project, input))
  while (directory !== project && dirname(directory) !== directory) {
    try {
      const meta = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
      if (meta.name && meta.version) {
        packages.add(directory)
        break
      }
    } catch {}
    directory = dirname(directory)
  }
}
const notices = []
for (const directory of [...packages].sort()) {
  const meta = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  const names = (await readdir(directory)).filter((name) =>
    /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name),
  )
  notices.push(
    `${meta.name} ${meta.version} (${typeof meta.license === "string" ? meta.license : "see package license"})\n${await Promise.all(names.map((name) => readFile(join(directory, name), "utf8"))).then((texts) => texts.join("\n"))}`,
  )
}
await writeFile(
  join(app, "THIRD_PARTY_NOTICES.txt"),
  notices.join("\n\n----------------------------------------\n\n"),
)
console.log(`Bundled ${manifest.name} ${manifest.version}; all Node runtime dependencies included.`)

if (values.archives) {
  const assets = []
  for (const platform of values.platform ? [values.platform] : platforms) {
    const temporary = await mkdtemp(join(output, ".archive-"))
    try {
      const payload = join(temporary, "payload")
      const runtime = join(payload, "runtime")
      await downloadRuntime(platform, runtime)
      await cp(app, join(payload, "app"), { recursive: true })
      await writeFile(join(payload, "VERSION"), `${manifest.version}\n`)
      const name = `you-should-know-${platform}.tar.gz`
      execFileSync(
        "tar",
        ["-czf", join(output, name), "-C", payload, "app", "runtime", "VERSION"],
        { stdio: "pipe" },
      )
      assets.push(name)
      console.log(`Built ${name} with Node ${nodeVersion}.`)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  for (const name of ["install.sh", "install.ps1"]) {
    const text = await readFile(join(project, name), "utf8")
    if (!text.includes(manifest.version))
      throw new Error(`Installer version does not match package: ${name}`)
    await copyFile(join(project, name), join(output, name))
    assets.push(name)
  }
  const sums = await Promise.all(
    assets.map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(join(output, name)))
          .digest("hex")}  ${name}`,
    ),
  )
  await writeFile(join(output, "SHA256SUMS"), `${sums.join("\n")}\n`)
}
