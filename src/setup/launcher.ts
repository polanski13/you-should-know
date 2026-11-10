import { chmod } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { readOptional, shellQuote, updateFile, windowsQuote } from "./files.js"

const start = "# >>> You Should Know >>>"
const end = "# <<< You Should Know <<<"

export function pathBlock(text: string, bin: string): string {
  const block = `${start}\nexport PATH=${shellQuote(bin)}:"$PATH"\n${end}`
  const first = text.indexOf(start)
  if (first >= 0) {
    const last = text.indexOf(end, first)
    if (last < 0)
      throw new Error(
        "Incomplete You Should Know PATH block; the shell configuration was preserved",
      )
    return `${text.slice(0, first)}${block}${text.slice(last + end.length)}`
  }
  return `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n${block}\n`
}

export async function installLauncher(options: {
  cliPath: string
  nodePath: string
  root: string
  env?: NodeJS.ProcessEnv
  configurePath?: boolean
}): Promise<string> {
  const env = options.env ?? process.env
  const home = env.HOME || env.USERPROFILE || homedir()
  const bin =
    env.YSK_BIN_DIR ||
    (process.platform === "win32" ? join(options.root, "bin") : join(home, ".local", "bin"))
  const launcher = join(bin, process.platform === "win32" ? "ysk.cmd" : "ysk")
  const content =
    process.platform === "win32"
      ? `@echo off\r\nrem You Should Know launcher\r\n${windowsQuote(options.nodePath)} ${windowsQuote(options.cliPath)} %*\r\n`
      : `#!/bin/sh\n# You Should Know launcher\nexec ${shellQuote(options.nodePath)} ${shellQuote(options.cliPath)} "$@"\n`
  const existing = await readOptional(launcher)
  if (
    existing &&
    !existing.includes("You Should Know launcher") &&
    !existing.includes(options.cliPath)
  ) {
    throw new Error(`Another program already owns ${launcher}; choose YSK_BIN_DIR`)
  }
  await updateFile(launcher, () => content, 0o755)
  if (process.platform !== "win32") await chmod(launcher, 0o755)
  if (options.configurePath === false) return launcher
  if (process.platform === "win32") {
    const script = `$bin = '${bin.replaceAll("'", "''")}'; $path = [Environment]::GetEnvironmentVariable('Path', 'User'); $parts = @($path -split ';' | Where-Object { $_ }); if ($parts -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User') }`
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    )
    if (result.status !== 0)
      throw new Error(`The launcher is installed at ${launcher}, but PATH could not be updated`)
  } else {
    const shell = basename(env.SHELL || "/bin/sh")
    if (shell === "fish") {
      const path = join(
        env.XDG_CONFIG_HOME || join(home, ".config"),
        "fish",
        "conf.d",
        "you-should-know.fish",
      )
      await updateFile(path, () => `fish_add_path ${shellQuote(bin)}\n`)
    } else {
      const paths =
        shell === "zsh"
          ? [join(env.ZDOTDIR || home, ".zshrc")]
          : shell === "bash"
            ? [
                join(home, ".bashrc"),
                join(
                  home,
                  (await readOptional(join(home, ".bash_profile"))) !== undefined
                    ? ".bash_profile"
                    : ".profile",
                ),
              ]
            : [join(home, ".profile")]
      for (const path of paths) await updateFile(path, (text) => pathBlock(text ?? "", bin))
    }
  }
  return launcher
}
