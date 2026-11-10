import { constants } from "node:fs"
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import lockfile from "proper-lockfile"
import { isErrno } from "../core/config.js"

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined
    throw error
  }
}

export async function updateFile(
  path: string,
  update: (text: string | undefined) => Promise<string | undefined> | string | undefined,
  mode = 0o600,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const guard = `${path}.ysk-write`
  await (await open(guard, "a", 0o600)).close()
  const release = await lockfile.lock(guard, { retries: 5 })
  try {
    const original = await readOptional(path)
    const next = await update(original)
    if (next === undefined || next === original) return false
    if (original !== undefined) {
      try {
        await copyFile(path, `${path}.before-ysk`, constants.COPYFILE_EXCL)
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error
      }
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, "wx", mode)
      try {
        await file.writeFile(next)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return true
  } finally {
    await release()
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function windowsQuote(value: string): string {
  if (/["\r\n%]/.test(value))
    throw new Error("Windows command paths cannot contain quotes, newlines or percent signs")
  return `"${value}"`
}
