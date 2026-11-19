import { createHash } from "node:crypto"
import type { FileHandle } from "node:fs/promises"

// A single image or tool result may span several read blocks.
export const maxRecordBytes = 8_000_000
const blockBytes = 128 * 1024

export async function readBytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length)
  for (let filled = 0; filled < length;) {
    const { bytesRead } = await file.read(result, filled, length - filled, start + filled)
    if (!bytesRead) throw new Error("Transcript changed during reading")
    filled += bytesRead
  }
  return result
}

export async function hashRange(
  file: FileHandle,
  start: number,
  end: number,
  hash = createHash("sha256"),
) {
  for (let at = start; at < end; at += blockBytes) {
    hash.update(await readBytes(file, at, Math.min(end - at, blockBytes)))
  }
  return hash
}

export async function* records(file: FileHandle, start: number, end: number) {
  let offset = start
  let parts: Buffer[] = []
  let length = 0
  for (let position = start; position < end;) {
    const block = await readBytes(file, position, Math.min(blockBytes, end - position))
    let from = 0
    while (from < block.length) {
      const lf = block.indexOf(10, from)
      const until = lf === -1 ? block.length : lf
      length += until - from
      if (length <= maxRecordBytes) parts.push(block.subarray(from, until))
      else parts = []
      if (lf === -1) break
      const next = position + lf + 1
      yield {
        offset,
        length,
        next,
        terminated: true,
        text: length > maxRecordBytes ? undefined : Buffer.concat(parts, length).toString("utf8"),
      }
      offset = next
      parts = []
      length = 0
      from = lf + 1
    }
    position += block.length
  }
  if (length)
    yield {
      offset,
      length,
      next: end,
      terminated: false,
      text: length > maxRecordBytes ? undefined : Buffer.concat(parts, length).toString("utf8"),
    }
}
