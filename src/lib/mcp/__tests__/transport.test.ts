import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Remote MCP servers speak one of two protocols: Streamable HTTP (current) or the
 * legacy HTTP+SSE pair (a long-lived GET for messages, separate POSTs for sends).
 * Plenty of deployed servers — including several official ones — still only offer
 * SSE, and their endpoints are conventionally published as `…/sse`. Connectors
 * used to be stored and dialled as Streamable HTTP unconditionally, so an `/sse`
 * URL was saved happily and then failed to connect with no way to fix it.
 */
import { inferRemoteTransport } from "../types";

describe("inferRemoteTransport", () => {
  it("reads the legacy SSE convention off the URL path", () => {
    expect(inferRemoteTransport("https://mcp.notion.com/sse")).toBe("sse");
    expect(inferRemoteTransport("https://host.example/v1/sse/")).toBe("sse");
    expect(inferRemoteTransport("https://host.example/SSE")).toBe("sse");
  });

  it("defaults to Streamable HTTP for everything else", () => {
    expect(inferRemoteTransport("https://mcp.tavily.com/mcp/")).toBe("http");
    expect(inferRemoteTransport("https://host.example/sse-events/mcp")).toBe("http");
    expect(inferRemoteTransport("https://host.example/ssevents")).toBe("http");
  });

  it("does not throw on a URL it can't parse", () => {
    expect(inferRemoteTransport("not a url")).toBe("http");
  });
});

// ── connectMcpServer picks the transport ────────────────────────────────────
const { FakeStreamableHttp, FakeSse, guardedFetchCalls } = vi.hoisted(() => ({
  FakeStreamableHttp: class {
    constructor(public url: URL, public opts: Record<string, unknown>) {}
  },
  FakeSse: class {
    constructor(public url: URL, public opts: Record<string, unknown>) {}
  },
  guardedFetchCalls: [] as { timeoutMs?: number }[],
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: FakeStreamableHttp,
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: FakeSse }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn(async () => {});
    listTools = vi.fn(async () => ({ tools: [{ name: "search" }] }));
    close = vi.fn(async () => {});
    setRequestHandler = vi.fn();
    getServerVersion = vi.fn(() => ({ name: "fake" }));
  },
}));
vi.mock("@/lib/net/ssrf", () => ({
  assertSafeUrl: vi.fn(async () => {}),
  createGuardedFetch: (opts: { timeoutMs?: number }) => {
    guardedFetchCalls.push(opts);
    return vi.fn();
  },
}));

import { connectMcpServer } from "../client";

const remote = (url: string, transport?: "http" | "sse") => ({
  name: "srv",
  transport: (transport ?? "http") as "http" | "sse",
  url,
  enabled: true,
});

beforeEach(() => {
  guardedFetchCalls.length = 0;
});

describe("connectMcpServer — remote transport selection", () => {
  it("dials an sse connector over the legacy SSE transport", async () => {
    const conn = await connectMcpServer(remote("https://host.example/sse", "sse"), {});
    expect(conn.transport).toBeInstanceOf(FakeSse);
  });

  it("dials an http connector over Streamable HTTP", async () => {
    const conn = await connectMcpServer(remote("https://host.example/mcp", "http"), {});
    expect(conn.transport).toBeInstanceOf(FakeStreamableHttp);
  });

  it("falls back to the URL shape when the stored row has no transport", async () => {
    // Rows written before transport was persisted carry `transport: "http"` for
    // every remote server, so the URL is the better signal for an /sse endpoint.
    const conn = await connectMcpServer({ ...remote("https://host.example/sse"), transport: undefined as never }, {});
    expect(conn.transport).toBeInstanceOf(FakeSse);
  });

  it("does not put a request deadline on the long-lived SSE stream", async () => {
    // The stream is meant to stay open for the whole session; an AbortSignal.timeout
    // would tear it down mid-turn. The handshake is still bounded by withTimeout and
    // each JSON-RPC call by the MCP SDK's own request timeout.
    await connectMcpServer(remote("https://host.example/sse", "sse"), {});
    expect(guardedFetchCalls.at(-1)?.timeoutMs).toBeUndefined();
  });

  it("keeps the per-request deadline for Streamable HTTP", async () => {
    await connectMcpServer(remote("https://host.example/mcp", "http"), {});
    expect(guardedFetchCalls.at(-1)?.timeoutMs).toBeGreaterThan(0);
  });
});
