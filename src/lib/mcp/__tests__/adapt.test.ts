import { describe, it, expect, vi } from "vitest";
import { mcpToolName, adaptMcpTool } from "../adapt";

describe("mcpToolName", () => {
  it("namespaces server + tool", () => {
    expect(mcpToolName("notion", "search")).toBe("mcp__notion__search");
  });
});

describe("adaptMcpTool", () => {
  it("wraps an MCP tool and routes execute to callTool", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
    const t = adaptMcpTool(client as never, "notion", {
      name: "search",
      description: "Search Notion",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect(t.description).toBe("Search Notion");
    // dynamic tools carry their input schema
    expect(t.inputSchema).toBeDefined();
    const out = await t.execute!({ q: "hi" }, { toolCallId: "1", messages: [] } as never);
    expect(client.callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "hi" } });
    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
  });
});
