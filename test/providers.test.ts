import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { CodexProvider, observerCodexConfig } from "../src/providers/codex.js"
import { HttpProvider } from "../src/providers/http.js"
import { providerConfigSchema } from "../src/core/config.js"
import { modelResponseSchema } from "../src/core/prompt.js"
import type { ModelRequest } from "../src/core/types.js"
import { Observer } from "../src/core/observer.js"
import { config, MemoryStore, observation } from "./helpers.js"

const request = (): ModelRequest => ({
  system: "Return JSON only.",
  prompt: 'Return {"note":null}.',
  schema: modelResponseSchema,
  signal: AbortSignal.timeout(5_000),
  maxOutputTokens: 1_200,
})
const fixture = fileURLToPath(new URL("./fixtures/codex-server.mjs", import.meta.url))

test("the optional native-only schema is scoped to Codex and preserves structured output", async () => {
  for (const enabled of [false, true]) {
    const provider = new CodexProvider({
      executable: process.execPath,
      args: [fixture],
      env: {
        MOCK_CODEX_MODE: enabled ? "schema-native" : "schema-default",
        YSK_CODEX_NATIVE_SCHEMA_ONLY: enabled ? "1" : "0",
      },
    })
    const observer = new Observer(new MemoryStore(), config)
    assert.deepEqual(await observer.observe(observation, provider), {
      status: "quiet",
      reason: "no_finding",
    })
  }
})

test("Codex speaks the real JSON-lines protocol with an isolated, tool-free thread", async () => {
  const provider = new CodexProvider({ executable: process.execPath, args: [fixture] })
  assert.deepEqual(await provider.complete(request()), { text: '{"note":null}' })
})

test("Codex refuses unsafe permissions, tool activity and approval requests", async () => {
  for (const mode of ["unsafe", "tool", "action"]) {
    const provider = new CodexProvider({
      executable: process.execPath,
      args: [fixture],
      env: { MOCK_CODEX_MODE: mode },
    })
    await assert.rejects(provider.complete(request()))
  }
})

test("Codex cancellation terminates a waiting app-server", async () => {
  const provider = new CodexProvider({
    executable: process.execPath,
    args: [fixture],
    env: { MOCK_CODEX_MODE: "hang" },
  })
  await assert.rejects(provider.complete({ ...request(), signal: AbortSignal.timeout(150) }))
})

test("Codex disables every configured MCP server and recursive observation", () => {
  const config = observerCodexConfig(["one", "two"])
  assert.deepEqual(config.mcp_servers, { one: { enabled: false }, two: { enabled: false } })
  assert.equal(config["features.hooks"], false)
  assert.equal(config["features.plugins"], false)
  assert.equal(config["features.code_mode"], false)
  assert.equal(config.default_permissions, ":read-only")
})

test("OpenAI-compatible provider sends bounded text-only JSON requests", async () => {
  let received: Record<string, unknown> = {}
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions")
    assert.equal(req.headers.authorization, "Bearer fixture-key")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"note":null}' } }],
        model: "served-model",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 },
        },
      }),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const config = providerConfigSchema.parse({
      type: "openai-compatible",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    })
    const result = await new HttpProvider(config, { OPENAI_API_KEY: "fixture-key" }).complete(
      request(),
    )
    assert.equal(result.text, '{"note":null}')
    assert.equal(result.model, "served-model")
    assert.deepEqual(result.usage, {
      inputTokens: 120,
      outputTokens: 8,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 12,
      uncachedInputTokens: 28,
    })
    assert.equal(received.tools, undefined)
    assert.equal(received.max_tokens, 1_200)
    assert.deepEqual(received.response_format, { type: "json_object" })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("HTTP errors do not expose response bodies or credentials", async () => {
  const config = providerConfigSchema.parse({ type: "openai-compatible", model: "fixture" })
  const fetcher: typeof fetch = async () =>
    new Response("secret input echoed by a proxy", { status: 401 })
  await assert.rejects(
    new HttpProvider(config, { OPENAI_API_KEY: "secret" }, fetcher).complete(request()),
    { message: "Model endpoint returned HTTP 401" },
  )
})

test("HTTP responses with tool calls are rejected", async () => {
  const config = providerConfigSchema.parse({ type: "openai-compatible", model: "fixture" })
  const fetcher: typeof fetch = async () =>
    Response.json({
      choices: [{ message: { tool_calls: [{ name: "shell" }], content: '{"note":null}' } }],
    })
  await assert.rejects(
    new HttpProvider(config, { OPENAI_API_KEY: "fixture" }, fetcher).complete(request()),
    /text-only/,
  )
})

test("HTTP provider does not forward credentials across redirects", async () => {
  const config = providerConfigSchema.parse({ type: "openai-compatible", model: "fixture" })
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, "error")
    return Response.json({ choices: [{ message: { content: '{"note":null}' } }] })
  }
  await new HttpProvider(config, { OPENAI_API_KEY: "fixture" }, fetcher).complete(request())
})

test("Anthropic uses the documented Messages API with no tools", async () => {
  const config = providerConfigSchema.parse({ type: "anthropic", model: "fixture" })
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, "https://api.anthropic.com/v1/messages")
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2026-10-21")
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.tools, undefined)
    assert.equal(body.max_tokens, 1_200)
    return Response.json({
      content: [{ type: "text", text: '{"note":null}' }],
      usage: {
        input_tokens: 28,
        output_tokens: 8,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 12,
        cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 },
      },
    })
  }
  const result = await new HttpProvider(config, { ANTHROPIC_API_KEY: "fixture" }, fetcher).complete(
    request(),
  )
  assert.equal(result.text, '{"note":null}')
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 8,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 12,
    uncachedInputTokens: 28,
    cacheWrite5mInputTokens: 5,
    cacheWrite1hInputTokens: 7,
  })
})

test("Codex reports the total for this observation and ignores other threads", async () => {
  const provider = new CodexProvider({
    executable: process.execPath,
    args: [fixture],
    env: { MOCK_CODEX_MODE: "usage" },
  })
  const result = await provider.complete(request())
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 8,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 12,
    uncachedInputTokens: 28,
  })
})
