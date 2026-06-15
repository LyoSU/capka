import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { adaptMcpTool, mcpToolName } from "../adapt";

describe("MCP round-trip (in-memory)", () => {
  it("lists a tool, adapts it, and executes a call", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    server.registerTool(
      "echo",
      { description: "Echo back", inputSchema: { msg: z.string() } },
      async ({ msg }) => ({ content: [{ type: "text", text: `echo:${msg}` }] }),
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1.0.0" });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
    expect(mcpToolName("test", "echo")).toBe("mcp__test__echo");

    const adapted = adaptMcpTool(client as never, "test", tools[0] as never);
    const out = (await adapted.execute!({ msg: "hi" }, { toolCallId: "1", messages: [] } as never)) as {
      content: { type: string; text: string }[];
    };
    expect(out.content[0].text).toBe("echo:hi");

    await client.close();
  });
});
