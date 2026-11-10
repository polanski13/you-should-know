import type { ProviderConfig } from "../core/config.js"
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/types.js"
import { object } from "./json-lines.js"

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Model endpoint returned HTTP ${response.status}`)
  }
  if (!response.body) throw new Error("Model endpoint returned an empty response")
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 1_000_000) {
        await reader.cancel()
        throw new Error("Model response exceeds its size limit")
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

export class HttpProvider implements ModelProvider {
  readonly name: string

  constructor(
    private readonly config: ProviderConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.name = config.type
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const anthropic = this.config.type === "anthropic"
    const keyName = this.config.apiKeyEnv ?? (anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")
    const key = this.env[keyName]
    if (!key) throw new Error(`Set ${keyName} before using the ${this.name} provider`)
    if (!this.config.model) throw new Error("Choose a model in the You Should Know configuration")
    const base = (
      this.config.baseUrl ??
      (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")
    ).replace(/\/+$/, "")
    const officialOpenAI = new URL(base).hostname === "api.openai.com"
    const headers: Record<string, string> = { "content-type": "application/json" }
    let body: Record<string, unknown>
    if (anthropic) {
      headers.authorization = `Bearer ${key}`
      headers["anthropic-version"] = "2026-10-21"
      body = {
        model: this.config.model,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxOutputTokens,
      }
    } else {
      headers.authorization = `Bearer ${key}`
      body = {
        model: this.config.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        [officialOpenAI ? "max_completion_tokens" : "max_tokens"]: request.maxOutputTokens,
        response_format: { type: "json_object" },
      }
    }
    const json = await readJson(
      await this.fetcher(`${base}/${anthropic ? "messages" : "chat/completions"}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
        redirect: "error",
      }),
    )
    if (anthropic) {
      const content = Array.isArray(json.content) ? json.content.map(object) : []
      if (content.some((item) => item.type === "tool_use"))
        throw new Error("Model attempted a tool call")
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
      if (!text) throw new Error("Model returned no text")
      return { text }
    }
    const choices = Array.isArray(json.choices) ? json.choices : []
    const message = object(object(choices[0]).message)
    if (message.tool_calls || typeof message.content !== "string")
      throw new Error("Model did not return a text-only response")
    return { text: message.content }
  }
}
