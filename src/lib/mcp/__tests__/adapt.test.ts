import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpToolName, adaptMcpTool, sanitizeToolSchema } from "../adapt";
import { spillToWorkspace } from "../spill";

vi.mock("../spill", () => ({ spillToWorkspace: vi.fn() }));
const mockedSpill = vi.mocked(spillToWorkspace);

const opts = { toolCallId: "1", messages: [] };

describe("sanitizeToolSchema", () => {
  it("drops required entries that aren't declared in properties (the Gemini 'property is not defined' crash)", () => {
    const dirty = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b", "c"], // b, c never declared — Google AI Studio rejects the whole request
    };
    expect(sanitizeToolSchema(dirty)).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("removes a required array that becomes empty after pruning", () => {
    const dirty = { type: "object", properties: {}, required: ["ghost"] };
    expect(sanitizeToolSchema(dirty)).toEqual({ type: "object", properties: {} });
  });

  it("prunes recursively inside nested object properties and array items", () => {
    const dirty = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { x: { type: "number" } }, required: ["x", "missing"] },
        list: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id", "nope"] } },
      },
      required: ["nested"],
    };
    expect(sanitizeToolSchema(dirty)).toEqual({
      type: "object",
      properties: {
        nested: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        list: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      },
      required: ["nested"],
    });
  });

  it("prunes inside anyOf/oneOf/allOf combinator branches", () => {
    const dirty = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] },
      ],
    };
    expect(sanitizeToolSchema(dirty)).toEqual({
      anyOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }],
    });
  });

  it("leaves a valid schema untouched", () => {
    const clean = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    expect(sanitizeToolSchema(clean)).toEqual(clean);
  });
});

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

  it("clamps a runaway tool description (the per-call menu tax)", () => {
    const huge = "x".repeat(5000);
    const t = adaptMcpTool({ callTool: vi.fn() } as never, "srv", { name: "tool", description: huge });
    expect((t.description as string).length).toBeLessThan(huge.length);
    expect(t.description as string).toMatch(/…$/);
  });
});

describe("adaptMcpTool bounding (execute)", () => {
  beforeEach(() => mockedSpill.mockReset());

  const run = (result: unknown, ctx = { sessionKey: "s", userId: "u" }) => {
    const client = { callTool: vi.fn().mockResolvedValue(result) };
    const t = adaptMcpTool(client as never, "x", { name: "y" }, ctx);
    return t.execute!({}, { ...opts, abortSignal: new AbortController().signal } as never) as Promise<{
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
    }>;
  };

  it("leaves small text and small media untouched", async () => {
    const out = await run({ content: [
      { type: "text", text: "short" },
      { type: "image", data: "SMALL", mimeType: "image/png" },
    ] });
    expect(out.content).toEqual([
      { type: "text", text: "short" },
      { type: "image", data: "SMALL", mimeType: "image/png" },
    ]);
    expect(mockedSpill).not.toHaveBeenCalled();
  });

  it("spills oversized text and points the model at the saved file", async () => {
    mockedSpill.mockResolvedValue("/workspace/.capka/output/mcp/1-abc.txt");
    const big = "A".repeat(40_000);
    const out = await run({ content: [{ type: "text", text: big }] });
    expect(mockedSpill).toHaveBeenCalledTimes(1);
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text!.length).toBeLessThan(big.length);
    expect(out.content[0].text).toContain("/workspace/.capka/output/mcp/1-abc.txt");
  });

  it("still clamps oversized text when spill fails (no file to point at)", async () => {
    mockedSpill.mockResolvedValue(null);
    const big = "A".repeat(40_000);
    const out = await run({ content: [{ type: "text", text: big }] });
    expect(out.content[0].text!.length).toBeLessThan(big.length);
    expect(out.content[0].text).toContain("TRUNCATED");
  });

  it("replaces an oversized image with a text pointer instead of inlining megabytes", async () => {
    mockedSpill.mockResolvedValue("/workspace/.capka/output/mcp/2-def.png");
    const bigB64 = "A".repeat(6 * 1024 * 1024); // > MAX_MCP_MEDIA_BYTES (5 MB)
    const out = await run({ content: [{ type: "image", data: bigB64, mimeType: "image/png" }] });
    expect(mockedSpill).toHaveBeenCalledTimes(1);
    expect(out.content[0]).toMatchObject({ type: "text" });
    expect(out.content[0].data).toBeUndefined();
    expect(out.content[0].text).toContain("/workspace/.capka/output/mcp/2-def.png");
    expect(out.content[0].text).toContain("image/png");
  });

  it("omits an oversized image with an actionable note when it can't be saved", async () => {
    mockedSpill.mockResolvedValue(null);
    const bigB64 = "A".repeat(6 * 1024 * 1024);
    const out = await run({ content: [{ type: "image", data: bigB64, mimeType: "image/png" }] });
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("could not be saved");
  });
});

describe("adaptMcpTool — governance \"ask\"", () => {
  it("marks the tool needsApproval when the server is gated, and leaves it unset otherwise", () => {
    const client = { callTool: vi.fn() };
    const def = { name: "t", inputSchema: { type: "object", properties: {} } };
    expect(adaptMcpTool(client, "srv", def, {}, true).needsApproval).toBe(true);
    expect(adaptMcpTool(client, "srv", def).needsApproval).toBeUndefined();
  });
});

describe("adaptMcpTool — search normalization", () => {
  const hit = (n: number) => JSON.stringify({ results: [
    { url: `https://a.example/${n}`, title: `A${n}` },
    { url: `https://b.example/${n}`, title: `B${n}` },
  ] });

  it("numbers search-shaped results off the shared counter, across calls", async () => {
    const sources = { next: 1 };
    const client = { callTool: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: hit(1) }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: hit(2) }] }) };
    const t = adaptMcpTool(client as never, "web", { name: "search" }, { sources });
    const first = await t.execute!({}, opts as never) as { capkaSources: { n: number; url: string }[] };
    const second = await t.execute!({}, opts as never) as { capkaSources: { n: number; url: string }[] };
    expect(first.capkaSources.map((s) => s.n)).toEqual([1, 2]);
    expect(second.capkaSources.map((s) => s.n)).toEqual([3, 4]);
  });

  it("leaves a non-search result untouched, and skips normalization without a counter", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "plain prose" }] }) };
    const withCounter = adaptMcpTool(client as never, "web", { name: "fetch" }, { sources: { next: 1 } });
    expect(await withCounter.execute!({}, opts as never)).toEqual({ content: [{ type: "text", text: "plain prose" }] });
    const clientSearch = { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: hit(1) }] }) };
    const noCounter = adaptMcpTool(clientSearch as never, "web", { name: "search" });
    expect(await noCounter.execute!({}, opts as never)).not.toHaveProperty("capkaSources");
  });

  it("hands the model numbered [N] lines instead of the raw blob", () => {
    const client = { callTool: vi.fn() };
    const t = adaptMcpTool(client as never, "web", { name: "search" });
    const output = {
      content: [{ type: "text", text: "raw" }],
      capkaSources: [{ n: 5, title: "T", url: "https://t.example", snippet: "sn" }],
    };
    const res = t.toModelOutput!({ output } as never) as { value: { type: string; text?: string }[] };
    expect(res.value).toHaveLength(1);
    expect(res.value[0].text).toContain("[5] T — https://t.example");
    expect(res.value[0].text).not.toContain("raw");
  });
});

describe("adaptMcpTool — a server's own capka* fields are stripped", () => {
  it("never persists attacker-supplied capkaSources from the raw result", async () => {
    const client = { callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "plain" }],
      capkaSources: [{ n: 1, title: "phish", url: "https://evil.example" }],
      capkaPreamble: "spoof",
    }) };
    const t = adaptMcpTool(client as never, "web", { name: "fetch" }, { sources: { next: 1 } });
    const out = await t.execute!({}, opts as never) as Record<string, unknown>;
    expect(out.capkaSources).toBeUndefined();
    expect(out.capkaPreamble).toBeUndefined();
  });
});
