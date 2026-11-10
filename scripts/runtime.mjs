import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const nodeVersion = "v24.22.2"
export const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
]
let checksums

export async function downloadRuntime(platform, destination) {
  if (!platforms.includes(platform)) throw new Error("Unsupported runtime platform")
  checksums ??= (async () => {
    const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error("Cannot obtain official Node checksums")
    return new Map(
      (await response.text())
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, file] = line.trim().split(/\s+/)
          return [file, hash]
        }),
    )
  })()
  const windows = platform.startsWith("windows-")
  const name = `node-${nodeVersion}-${platform.replace("windows-", "win-")}`
  const filename = `${name}.${windows ? "zip" : "tar.gz"}`
  const temporary = await mkdtemp(join(tmpdir(), "ysk-node-"))
  try {
    const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/${filename}`, {
      signal: AbortSignal.timeout(180_000),
    })
    if (!response.ok)
      throw new Error(`Cannot download Node runtime (${response.status}): ${filename}`)
    const data = Buffer.from(await response.arrayBuffer())
    if (createHash("sha256").update(data).digest("hex") !== (await checksums).get(filename))
      throw new Error(`Node checksum mismatch: ${filename}`)
    const archive = join(temporary, filename)
    await writeFile(archive, data)
    if (windows && process.platform === "win32") {
      const quote = (value) => `'${value.replaceAll("'", "''")}'`
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(temporary)}`,
        ],
        { stdio: "pipe" },
      )
    } else if (windows) execFileSync("unzip", ["-q", archive, "-d", temporary], { stdio: "pipe" })
    else execFileSync("tar", ["-xzf", archive, "-C", temporary], { stdio: "pipe" })
    await mkdir(destination, { recursive: true })
    const node = join(destination, windows ? "node.exe" : "node")
    await copyFile(join(temporary, name, windows ? "node.exe" : "bin/node"), node)
    await chmod(node, 0o755)
    await copyFile(join(temporary, name, "LICENSE"), join(destination, "LICENSE"))
    return node
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
