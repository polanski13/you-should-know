import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/types.js"
import { ModelUnavailableError } from "../core/types.js"
import { JsonLineClient, object } from "./json-lines.js"
import { VERSION } from "../version.js"
import { inclusiveUsage } from "./usage.js"

const disabledFeatures = [
  "apps",
  "code_mode",
  "code_mode_only",
  "context_management",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "view_image",
] as const

export function observerCodexConfig(mcpNames: string[]): Record<string, unknown> {
  return {
    ...Object.fromEntries(disabledFeatures.map((feature) => [`features.${feature}`, false])),
    "cloud.skills.enabled": false,
    "skills.include_instructions": false,
    "tools.experimental_request_user_input.enabled": false,
    "tools.update_plan.enabled": false,
    web_search: "disabled",
    default_permissions: ":read-only",
    mcp_servers: Object.fromEntries(mcpNames.map((name) => [name, { enabled: false }])),
  }
}

export class CodexProvider implements ModelProvider {
  readonly name = "codex"
  get nativeOutputSchemaOnly(): boolean {
    const env = this.options.env
    return (
      (env && Object.hasOwn(env, "YSK_CODEX_NATIVE_SCHEMA_ONLY")
        ? env.YSK_CODEX_NATIVE_SCHEMA_ONLY
        : process.env.YSK_CODEX_NATIVE_SCHEMA_ONLY) === "1"
    )
  }
  get model(): string | undefined {
    return this.options.model
  }

  constructor(
    private readonly options: {
      executable?: string
      model?: string
      args?: string[]
      env?: NodeJS.ProcessEnv
    } = {},
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const directory = await mkdtemp(join(tmpdir(), "ysk-observer-"))
    let client: JsonLineClient | undefined
    try {
      client = new JsonLineClient(
        this.options.executable ?? "codex",
        this.options.args ?? ["app-server", "--stdio"],
        {
          cwd: directory,
          signal: request.signal,
          env: this.options.env,
        },
      )
      await client.request("initialize", {
        clientInfo: { name: "you_should_know", title: "You Should Know", version: VERSION },
        capabilities: { experimentalApi: true },
      })
      client.notify("initialized")
      const effective = object(
        await client.request("config/read", { includeLayers: false, cwd: directory }),
      )
      if (!effective.config || typeof effective.config !== "object")
        throw new Error("Codex did not return its effective configuration")
      const servers = object(object(effective.config).mcp_servers)
      const started = object(
        await client.request("thread/start", {
          ...(this.options.model ? { model: this.options.model } : {}),
          cwd: directory,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          runtimeWorkspaceRoots: [],
          environments: [],
          dynamicTools: [],
          selectedCapabilityRoots: [],
          baseInstructions: request.system,
          developerInstructions:
            "This is a one-response observation task. No tools or actions are available.",
          config: observerCodexConfig(Object.keys(servers)),
        }),
      )
      const threadId = object(started.thread).id
      if (typeof threadId !== "string" || object(started.sandbox).type !== "readOnly")
        throw new Error("Codex did not establish an isolated read-only thread")
      const response = await runTurn(client, threadId, request)
      const model =
        response.model ?? (typeof started.model === "string" ? started.model : this.model)
      return model ? { ...response, model } : response
    } finally {
      client?.close()
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function runTurn(
  client: JsonLineClient,
  threadId: string,
  request: ModelRequest,
): Promise<ModelResponse> {
  let finalText = ""
  let usage: ModelResponse["usage"]
  let model: string | undefined
  let completed = false
  let drain: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}
  const result = new Promise<void>((resolve, reject) => {
    unsubscribe = client.subscribe((method, raw) => {
      const params = object(raw)
      if (method === "ysk/closed") {
        if (completed) resolve()
        else reject(new Error("Codex closed during observation"))
        return
      }
      if (params.threadId !== threadId) return
      if (method === "model/rerouted" && typeof params.toModel === "string") model = params.toModel
      if (method === "thread/tokenUsage/updated") {
        // Each observation starts a fresh thread. Totals also cover internal continuations.
        const counts = object(object(params.tokenUsage).total)
        usage = inclusiveUsage(
          counts.inputTokens,
          counts.outputTokens,
          counts.cachedInputTokens,
          counts.cacheWriteInputTokens,
        )
        if (completed && usage) resolve()
      }
      if (method === "item/started" || method === "item/completed") {
        const item = object(params.item)
        if (!new Set(["userMessage", "agentMessage", "reasoning"]).has(String(item.type))) {
          reject(new Error("Codex attempted a non-observation action"))
          client.close()
          return
        }
        if (
          method === "item/completed" &&
          item.type === "agentMessage" &&
          typeof item.text === "string"
        )
          finalText = item.text
      }
      if (method === "turn/completed") {
        const turn = object(params.turn)
        const message = object(turn.error).message
        if (
          turn.status === "failed" &&
          typeof message === "string" &&
          /\bmodel_not_found\b|\bmodel(?:\s+[`'"][^`'"\n]{1,160}[`'"])?\s+(?:is (?:unavailable|not (?:supported|available|found))|does not exist)\b/i.test(
            message,
          )
        )
          reject(new ModelUnavailableError())
        else if (turn.status !== "completed" || !finalText)
          reject(new Error("Codex did not complete a text-only observation"))
        else {
          completed = true
          if (usage) resolve()
          // Some versions deliver usage just after completion. Text-only providers still finish.
          else drain = setTimeout(resolve, 150)
        }
      }
    })
  })
  result.catch(() => undefined)
  try {
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      effort: "low",
      summary: "none",
      outputSchema: request.schema,
    })
    await result
    return { text: finalText, ...(usage && { usage }), ...(model && { model }) }
  } finally {
    clearTimeout(drain)
    unsubscribe()
  }
}
