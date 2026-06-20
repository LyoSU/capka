import { describe, it, expect, vi } from "vitest";
import { mcpToolName, adaptMcpTool } from "../adapt";

const opts = { toolCallId: "1", messages: [] };

describe("mcpToolName", () => {
  it("namespaces server + tool", () => {
    expect(mcpToolName("notion", "search")).toBe("mcp__notion__search");
  });
});

describe("adaptMcpTool", () => {
  it("routes execute to callTool and forwards the abort signal", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }) };
    const ac = new AbortController();
    const t = adaptMcpTool(client as never, "notion", {
      name: "search",
      description: "Search Notion",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect(t.description).toBe("Search Notion");
    expect(t.inputSchema).toBeDefined();
    const out = await t.execute!({ q: "hi" }, { ...opts, abortSignal: ac.signal } as never);
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hi" } },
      undefined,
      { signal: ac.signal },
    );
    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("throws on a tool-level isError result (so it surfaces as a tool error)", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "rate limited" }] }) };
    const t = adaptMcpTool(client as never, "grok", { name: "search" });
    await expect(t.execute!({}, opts as never)).rejects.toThrow("rate limited");
  });

  it("maps result content to model output parts (text + media)", async () => {
    const client = { callTool: vi.fn() };
    const t = adaptMcpTool(client as never, "x", { name: "y" });
    const output = {
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "BASE64", mimeType: "image/png" },
      ],
    };
    expect(t.toModelOutput!({ toolCallId: "1", input: {}, output })).toEqual({
      type: "content",
      value: [
        { type: "text", text: "hello" },
        { type: "media", data: "BASE64", mediaType: "image/png" },
      ],
    });
  });
});
