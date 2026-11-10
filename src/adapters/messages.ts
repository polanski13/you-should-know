import { digest } from "../core/context.js"
import type { ContextMessage } from "../core/types.js"
import { object } from "../providers/json-lines.js"

export function textContent(value: unknown, depth = 0): string {
  if (depth > 8) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((part) => textContent(part, depth + 1))
      .filter(Boolean)
      .join("\n")
  const part = object(value)
  if (["image", "image_url", "media", "reasoning", "thinking"].includes(String(part.type)))
    return ""
  if (typeof part.text === "string") return part.text
  if (part.type === "json" && part.value !== undefined) return JSON.stringify(part.value)
  if (part.type === "tool-call" || part.type === "tool_use")
    return `${String(part.name ?? part.toolName ?? "tool")}: ${JSON.stringify(part.input ?? part.arguments ?? {})}`
  for (const key of ["content", "output", "result", "value"]) {
    if (part[key] !== undefined) return textContent(part[key], depth + 1)
  }
  return ""
}

export function normalizeMessages(raw: readonly unknown[]): ContextMessage[] {
  const result: ContextMessage[] = []
  for (const item of raw.slice(-500)) {
    const message = object(item)
    const role = message.role
    if (role !== "user" && role !== "assistant" && role !== "tool") continue
    const text = textContent(message.content ?? message.text).slice(0, 100_000)
    if (!text.trim()) continue
    const id =
      typeof message.id === "string"
        ? message.id
        : `${role}-${digest(text).slice(0, 20)}-${result.length}`
    result.push({ id: id.slice(0, 240), role, text })
  }
  return result
}
