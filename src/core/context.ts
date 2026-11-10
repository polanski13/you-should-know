import { createHash } from "node:crypto"
import type { ObserverConfig } from "./config.js"
import type { ContextMessage } from "./types.js"

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function cleanText(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")
}

export function redact(text: string): string {
  return cleanText(text)
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[redacted key]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
    .replace(
      /\b((?:[A-Z_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)|password|api_key|access_token|refresh_token)\s*[=:]\s*)["']?[^\s"',;]+["']?/gi,
      "$1[redacted]",
    )
}

export function topicKey(topic: string): string {
  return topic
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function comparable(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en")
}

export function prepareContext(
  messages: ContextMessage[],
  config: ObserverConfig,
): ContextMessage[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  if (lastUser < 0) return []
  const limit = Math.min(config.maxMessageChars, Math.floor(config.maxContextChars / 2))
  const prepare = (message: ContextMessage): ContextMessage => {
    const text = redact(message.text)
    const marker = "\n[...truncated...]\n"
    const half = Math.floor((limit - marker.length) / 2)
    return {
      ...message,
      text: text.length <= limit ? text : `${text.slice(0, half)}${marker}${text.slice(-half)}`,
    }
  }
  const selected = new Map<number, ContextMessage>()
  const user = prepare(messages[lastUser]!)
  selected.set(lastUser, user)
  let used = user.text.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i === lastUser) continue
    const message = prepare(messages[i]!)
    if (!message.text.trim() || selected.size >= 100) continue
    if (used + message.text.length > config.maxContextChars) continue
    selected.set(i, message)
    used += message.text.length
  }
  return [...selected.entries()].sort(([a], [b]) => a - b).map(([, message]) => message)
}
