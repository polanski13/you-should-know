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
    if (!safe) {
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
    send({ id: message.id, result: { turn: { id: "turn" } } })
    if (mode === "hang") continue
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
  }
}
