import { open } from "node:fs/promises"
import { digest } from "../core/context.js"
import type { ContextMessage } from "../core/types.js"
import { object } from "../providers/json-lines.js"
import { textContent } from "./messages.js"

export interface Transcript {
  messages: ContextMessage[]
  turnId?: string
  steps: number
}

export function parseTranscript(text: string): Transcript {
  const messages: ContextMessage[] = []
  let turnId: string | undefined
  let steps = 0
  for (const line of text.split("\n")) {
    let entry: Record<string, unknown>
    try {
      entry = object(JSON.parse(line))
    } catch {
      continue
    }
    const payload = object(entry.payload)
    if (entry.type === "turn_context" && typeof payload.turn_id === "string")
      turnId = payload.turn_id
    const message = entry.type === "response_item" ? payload : object(entry.message)
    let role = message.role
    let content = message.content
    if (message.type === "function_call_output" || message.type === "custom_tool_call_output") {
      role = "tool"
      content = message.output
      steps++
    }
    if (message.type === "function_call" || message.type === "custom_tool_call") {
      role = "assistant"
      content = `${String(message.name ?? "tool")}: ${String(message.arguments ?? message.input ?? "")}`
    }
    if (role !== "user" && role !== "assistant" && role !== "tool") continue
    if (entry.isSidechain === true) continue
    const blocks = Array.isArray(content) ? content.map(object) : []
    const isToolResult = blocks.some((part) => part.type === "tool_result")
    if (role === "user" && isToolResult) {
      role = "tool"
      steps++
    }
    const value = textContent(content).slice(0, 100_000)
    if (!value.trim()) continue
    const id =
      typeof entry.uuid === "string"
        ? entry.uuid
        : typeof message.id === "string"
          ? message.id
          : digest(`${role}:${value}:${String(entry.timestamp ?? messages.length)}`).slice(0, 24)
    if (role === "user") {
      steps = 0
      if (entry.type !== "response_item") turnId = id
    }
    messages.push({
      id: id.slice(0, 240),
      role: role === "tool" ? "tool" : role === "assistant" ? "assistant" : "user",
      text: value,
    })
  }
  return { messages: messages.slice(-500), turnId, steps }
}

export async function readTranscript(path: string): Promise<Transcript> {
  const file = await open(path, "r")
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error("Transcript must be a regular file")
    const start = Math.max(0, stat.size - 2_000_000)
    const buffer = Buffer.alloc(Math.min(stat.size, 2_000_000))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString("utf8")
    if (start > 0) text = text.slice(text.indexOf("\n") + 1)
    return parseTranscript(text)
  } finally {
    await file.close()
  }
}
