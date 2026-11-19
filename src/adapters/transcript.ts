import { open, stat as statPath } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { resolve } from "node:path"
import { digest } from "../core/context.js"
import type { TranscriptCursor } from "../core/store.js"
import type { ContextMessage } from "../core/types.js"
import { object } from "../providers/json-lines.js"
import { adapterText, recentMessages } from "./messages.js"
import { fingerprint, maxRecordBytes, readBytes, records } from "./transcript-file.js"

export interface Transcript {
  messages: ContextMessage[]
  turnId?: string
  steps: number
}

interface Event {
  message?: ContextMessage
  turnId?: string
  promptId?: string
  step?: boolean
}

function decode(line: string, offset: number): Event {
  let entry: Record<string, unknown>
  try {
    entry = object(JSON.parse(line))
  } catch {
    return {}
  }
  if (entry.isSidechain === true) return {}
  const payload = object(entry.payload)
  if (entry.type === "turn_context" && typeof payload.turn_id === "string")
    return { turnId: payload.turn_id }
  const message = entry.type === "response_item" ? payload : object(entry.message)
  let role = message.role
  let content = message.content
  let step = false
  if (message.type === "function_call_output" || message.type === "custom_tool_call_output") {
    role = "tool"
    content = message.output
    step = true
  }
  if (message.type === "function_call" || message.type === "custom_tool_call") {
    role = "assistant"
    content = `${String(message.name ?? "tool")}: ${String(message.arguments ?? message.input ?? "")}`
  }
  if (role !== "user" && role !== "assistant" && role !== "tool") return {}
  if (
    role === "user" &&
    Array.isArray(content) &&
    content.some((part) => object(part).type === "tool_result")
  ) {
    role = "tool"
    step = true
  }
  const text = adapterText(content)
  if (!text.trim()) return { step }
  const id = (
    typeof entry.uuid === "string"
      ? entry.uuid
      : typeof message.id === "string"
        ? message.id
        : digest(`${role}:${offset}:${String(entry.timestamp ?? "")}:${text}`).slice(0, 24)
  ).slice(0, 240)
  return {
    message: { id, role: role as ContextMessage["role"], text },
    step,
    promptId: role === "user" && typeof entry.promptId === "string" ? entry.promptId : undefined,
    turnId: role === "user" && entry.type !== "response_item" ? id : undefined,
  }
}

type Position = Pick<TranscriptCursor, "steps" | "turnId" | "user">

function advance(position: Position, event: Event) {
  if (event.turnId !== undefined && event.turnId !== position.turnId) {
    position.turnId = event.turnId
    position.steps = 0
    position.user = undefined
  }
  if (event.message?.role === "user") position.steps = 0
  if (event.step) position.steps++
}

export function parseTranscript(text: string): Transcript {
  const position: Position = { steps: 0 }
  const messages: ContextMessage[] = []
  let offset = 0
  for (const line of text.split("\n")) {
    const event = decode(line, offset)
    advance(position, event)
    if (event.message) messages.push(event.message)
    offset += Buffer.byteLength(line) + 1
  }
  return {
    turnId: position.turnId,
    steps: position.steps,
    messages: recentMessages(messages, (m) => m.role === "user"),
  }
}

async function restore(
  file: FileHandle,
  previous: TranscriptCursor | undefined,
  identity: string,
  size: number,
  modified: number,
) {
  if (
    !previous ||
    previous.file !== identity ||
    previous.size > size ||
    previous.offset > previous.size ||
    (previous.size === size && previous.modified !== modified)
  )
    return
  if (previous.fingerprint !== (await fingerprint(file, identity, previous.size, previous.offset)))
    return
  let user: ContextMessage | undefined
  let promptId: string | undefined
  if (previous.user) {
    const ref = previous.user
    if (ref.length > maxRecordBytes || ref.offset + ref.length > previous.offset) return
    const line = (await readBytes(file, ref.offset, ref.length)).toString("utf8")
    if (digest(line) !== ref.hash) return
    const event = decode(line, ref.offset)
    user = event.message
    promptId = event.promptId
    if (user?.role !== "user") return
  }
  return {
    position: { steps: previous.steps, turnId: previous.turnId, user: previous.user },
    user,
    promptId,
    offset: previous.offset,
  }
}

export async function readTranscript(
  path: string,
  previous?: TranscriptCursor,
): Promise<Transcript & { cursor: TranscriptCursor; promptId?: string }> {
  const file = await open(path, "r")
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error("Transcript must be a regular file")
    const identity = digest(JSON.stringify([resolve(path), stat.dev, stat.ino, stat.birthtimeMs]))
    const saved = await restore(file, previous, identity, stat.size, stat.mtimeMs)
    const position: Position = saved?.position ?? { steps: 0 }
    let latestUser = saved?.user
    let promptId = saved?.promptId
    const cutoff = Math.max(0, stat.size - 2_000_000)
    const start = saved?.offset ?? 0
    let offset = start
    let checkpoint: Position = { ...position }
    const messages: ContextMessage[] = []
    for await (const row of records(file, start, stat.size)) {
      if (row.text === undefined) {
        // Its role is unknown. Wait for a visible user before attributing later evidence.
        position.user = undefined
        position.turnId = undefined
        position.steps = 0
        latestUser = undefined
        promptId = undefined
        messages.length = 0
      } else {
        const event = decode(row.text, row.offset)
        if (event.turnId !== undefined && event.turnId !== position.turnId) {
          latestUser = undefined
          promptId = undefined
        }
        advance(position, event)
        if (event.message?.role === "user") {
          position.user = { offset: row.offset, length: row.length, hash: digest(row.text) }
          latestUser = event.message
          promptId = event.promptId
        }
        if (row.next > cutoff && event.message) messages.push(event.message)
      }
      if (row.next <= cutoff) {
        offset = row.next
        checkpoint = { ...position }
      }
    }
    const cursor: TranscriptCursor = {
      file: identity,
      size: stat.size,
      modified: stat.mtimeMs,
      offset,
      ...checkpoint,
      fingerprint: await fingerprint(file, identity, stat.size, offset),
    }
    const current = await statPath(path)
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.birthtimeMs !== stat.birthtimeMs ||
      current.size < stat.size ||
      (current.size === stat.size && current.mtimeMs !== stat.mtimeMs)
    )
      throw new Error("Transcript changed during reading")
    if (latestUser && !messages.includes(latestUser)) messages.unshift(latestUser)
    return {
      cursor,
      promptId,
      turnId: position.turnId,
      steps: position.steps,
      messages: latestUser ? recentMessages(messages, (m) => m.role === "user") : [],
    }
  } finally {
    await file.close()
  }
}
