import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { feedbackSchema, messageSchema } from "../core/types.js"
import type { Runtime } from "../runtime.js"

export function createMcpServer(runtime: Runtime): McpServer {
  const server = new McpServer({ name: "you-should-know", version: "0.1.0" })
  const output = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  })
  server.registerTool(
    "ysk_observe",
    {
      title: "Get a quiet second opinion",
      description:
        "Look for one consequential oversight in the supplied conversation. Usually returns no note. This makes a model request and uses the configured provider's quota. Pass only relevant user-visible messages; do not include credentials or hidden reasoning. Call once after meaningful progress, not after every tool call.",
      inputSchema: {
        sessionId: z.string().min(1).max(240),
        turnId: z.string().min(1).max(240),
        step: z.number().int().min(0),
        messages: z.array(messageSchema).max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) =>
      output(await runtime.observer.observe({ ...input, host: "mcp" }, runtime.provider)),
  )
  server.registerTool(
    "ysk_notes",
    {
      title: "Read observation notes",
      description: "Read saved notes for this project. This does not call a model.",
      inputSchema: { sessionId: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ sessionId }) => output(await runtime.observer.notes(sessionId)),
  )
  server.registerTool(
    "ysk_feedback",
    {
      title: "Respond to a note",
      description:
        "Record the person's explicit feedback. Use known only when the person says they already understand the topic. Do not decide this on their behalf.",
      inputSchema: { id: z.string(), feedback: feedbackSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, feedback }) => output(await runtime.observer.feedback(id, feedback)),
  )
  server.registerResource(
    "notes",
    "ysk://notes",
    { title: "You Should Know notes", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await runtime.observer.notes()),
        },
      ],
    }),
  )
  return server
}

export async function serveMcp(runtime: Runtime): Promise<void> {
  const server = createMcpServer(runtime)
  const close = () => {
    runtime.observer.dispose()
    void server.close()
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
  await server.connect(new StdioServerTransport())
}
