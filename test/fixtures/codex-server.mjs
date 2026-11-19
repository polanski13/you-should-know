import { createInterface } from "node:readline"

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const mode = process.env.MOCK_CODEX_MODE
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } })
  if (message.method === "config/read")
    send({
      id: message.id,
      result: { config: { mcp_servers: { private: { command: "never-run" } } } },
    })
  if (message.method === "thread/start") {
    const params = message.params
    const safe =
      params.ephemeral &&
      params.environments.length === 0 &&
      params.runtimeWorkspaceRoots.length === 0 &&
      params.config["features.hooks"] === false &&
      params.config["features.shell_tool"] === false &&
      params.config.mcp_servers.private.enabled === false &&
      params.config.web_search === "disabled"
    if (!safe || (mode === "missing-model" && params.model !== "unavailable-fixture")) {
      send({ id: message.id, error: { code: -32602 } })
      continue
    }
    send({
      id: message.id,
      result: {
        thread: { id: "observer" },
        sandbox: { type: mode === "unsafe" ? "dangerFullAccess" : "readOnly" },
      },
    })
  }
  if (message.method === "turn/start") {
    if (mode === "schema-default" || mode === "schema-native") {
      const schema = message.params.outputSchema
      const inText = message.params.input[0].text.includes("\n\nResponse schema:\n")
      if (!schema?.properties?.note || inText !== (mode === "schema-default")) {
        send({ id: message.id, error: { code: -32602 } })
        continue
      }
    }
    send({ id: message.id, result: { turn: { id: "turn" } } })
    if (mode === "hang") continue
    if (["missing-model", "unavailable-model-text", "service-unavailable"].includes(mode)) {
      send({
        method: "turn/completed",
        params: {
          threadId: "observer",
          turn: {
            status: "failed",
            error: {
              codexErrorInfo: "other",
              message:
                mode === "missing-model"
                  ? 'HTTP 400: {"code":"model_not_found","message":"private diagnostic"}'
                  : mode === "unavailable-model-text"
                    ? "The selected model is unavailable."
                    : "The upstream service is unavailable.",
            },
          },
        },
      })
      continue
    }
    if (mode === "late-usage") {
      for (const threadId of ["observer", "other"])
        send({
          method: "model/rerouted",
          params: {
            threadId,
            turnId: "turn",
            fromModel: "requested",
            toModel: threadId === "observer" ? "served" : "unrelated",
          },
        })
    }
    if (mode === "usage") {
      for (const threadId of ["observer", "other"]) {
        send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId: "turn",
            tokenUsage: {
              total: {
                inputTokens: threadId === "observer" ? 120 : 999,
                outputTokens: 8,
                cachedInputTokens: 80,
                cacheWriteInputTokens: 12,
              },
              last: {
                inputTokens: 5,
                outputTokens: 1,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
              },
            },
          },
        })
      }
    }
    if (mode === "action") {
      send({
        id: "approval",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "observer" },
      })
      continue
    }
    if (mode === "tool") {
      send({
        method: "item/started",
        params: { threadId: "observer", item: { type: "commandExecution", command: "never-run" } },
      })
      continue
    }
    send({
      method: "item/completed",
      params: { threadId: "observer", item: { type: "agentMessage", text: '{"note":null}' } },
    })
    send({
      method: "turn/completed",
      params: { threadId: "observer", turn: { id: "turn", status: "completed" } },
    })
    if (mode === "late-usage") {
      setTimeout(
        () =>
          send({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "observer",
              turnId: "turn",
              tokenUsage: {
                total: {
                  inputTokens: 82,
                  cachedInputTokens: 20,
                  cacheWriteInputTokens: 0,
                  outputTokens: 7,
                },
              },
            },
          }),
        15,
      )
    }
  }
}
