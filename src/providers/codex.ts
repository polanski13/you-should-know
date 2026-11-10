import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelProvider, ModelRequest, ModelResponse } from "../core/types.js"
import { JsonLineClient, object } from "./json-lines.js"

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
        clientInfo: { name: "you_should_know", title: "You Should Know", version: "0.1.0" },
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
      return await runTurn(client, threadId, request)
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
  let unsubscribe = () => {}
  const result = new Promise<ModelResponse>((resolve, reject) => {
    unsubscribe = client.subscribe((method, raw) => {
      const params = object(raw)
      if (method === "ysk/closed") {
        reject(new Error("Codex closed during observation"))
        return
      }
      if (params.threadId !== threadId) return
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
        if (turn.status !== "completed" || !finalText)
          reject(new Error("Codex did not complete a text-only observation"))
        else resolve({ text: finalText })
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
    return await result
  } finally {
    unsubscribe()
  }
}
