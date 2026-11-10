import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../src/adapters/mcp.js"
import { createRuntime } from "../src/runtime.js"
import { config, observation, provider } from "./helpers.js"

test("MCP clients can observe, read evidence, and record explicit feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ysk-mcp-test-"))
  const client = new Client({ name: "test", version: "1.0.0" })
  let server: ReturnType<typeof createMcpServer> | undefined
  try {
    const path = join(root, "config.json")
    await writeFile(path, JSON.stringify({ observer: config }))
    const runtime = await createRuntime(root, path, { YSK_DATA_DIR: join(root, "state") })
    server = createMcpServer({ ...runtime, provider: provider() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "ysk_feedback",
      "ysk_notes",
      "ysk_observe",
    ])
    const { host: _host, ...input } = observation
    const result = await client.callTool({ name: "ysk_observe", arguments: input })
    const content = result.content as { type: string; text: string }[]
    const value = JSON.parse(content[0]!.text) as { status: string; note: { id: string } }
    assert.equal(value.status, "shown")
    const feedback = await client.callTool({
      name: "ysk_feedback",
      arguments: { id: value.note.id, feedback: "known" },
    })
    assert.notEqual(feedback.isError, true)
    const resource = await client.readResource({ uri: "ysk://notes" })
    assert.ok(JSON.stringify(resource.contents).includes("known"))
  } finally {
    await client.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})
