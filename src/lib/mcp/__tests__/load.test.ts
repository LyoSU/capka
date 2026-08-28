import { describe, it, expect, vi, beforeEach } from "vitest";

// Contract: loadMcpTools must NEVER block the start of a turn on a stdio
// connector's connect. A stdio server is launched inside the chat's sandbox via
// `docker exec`, and `npx`/`uvx` self-install its package on first run — tens of
// seconds in a fresh per-chat container (and up to the connect timeout when the
// sandbox has no egress). Doing that synchronously here delayed time-to-first-
// token for EVERY turn. So stdio tools are served from an in-process schema cache
// and the real connect (plus ensureSession) is deferred to the first actual tool
// call; a cold cache is warmed in the background. http connectors stay eager
// (a remote handshake is sub-second).

const listEnabledServerConfigs = vi.fn();
const connectMcpServer = vi.fn();
const disconnectMcp = vi.fn(async () => {});
const recordConnectError = vi.fn();
const hasUserTokens = vi.fn<(...a: unknown[]) => Promise<boolean>>(() => Promise.resolve(true));

vi.mock("../service", () => ({ listEnabledServerConfigs: (...a: unknown[]) => listEnabledServerConfigs(...a) }));
vi.mock("../client", () => ({
  connectMcpServer: (...a: unknown[]) => connectMcpServer(...a),
  disconnectMcp: (...a: unknown[]) => disconnectMcp(...(a as [])),
}));
vi.mock("../adapt", () => ({
  // Capture the caller passed in so a test can exercise the lazy-connect path,
  // and the needsApproval flag so a test can assert governance-"ask" threading.
  adaptMcpTool: (client: unknown, server: string, tool: { name: string }, _ctx: unknown, needsApproval?: boolean) =>
    ({ __caller: client, __server: server, __tool: tool.name, __needsApproval: needsApproval }),
  mcpToolName: (s: string, t: string) => `mcp__${s}__${t}`,
}));
vi.mock("../connect-errors", () => ({
  recordConnectError: (...a: unknown[]) => recordConnectError(...a),
  clearConnectError: vi.fn(),
  recentlyFailed: vi.fn(() => false),
}));
vi.mock("../oauth/provider", () => ({ McpOAuthProvider: class {} }));
vi.mock("../oauth/store", () => ({ hasUserTokens: (...a: unknown[]) => hasUserTokens(...a) }));
vi.mock("../plugin-runtime", () => ({ needsPluginRoot: () => false, resolvePluginRoot: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getBlockPrivateProviderUrls: async () => false }));

import { loadMcpTools } from "../load";
import { getCachedTools, setCachedTools, clearCachedTools, SCHEMA_TTL_MS, type CachedTool } from "../tool-cache";

/** Write a cache entry stamped before the TTL, so it reads as stale under the real
 *  clock. Setting the system time BACK for the write (rather than advancing it
 *  after) keeps the rest of the test on real timers, which the async paths need. */
function stampCacheInThePast(serverId: string, tools: CachedTool[]) {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() - (SCHEMA_TTL_MS + 60_000));
  setCachedTools(serverId, tools);
  vi.useRealTimers();
}

const cfg = (name: string, transport: "stdio" | "http") => ({
  id: name, name, transport, enabled: true, authKind: "token",
  url: transport === "http" ? "https://e.x/mcp" : null,
  command: transport === "stdio" ? "server" : undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  disconnectMcp.mockResolvedValue(undefined);
  clearCachedTools("plug");
  clearCachedTools("api");
  connectMcpServer.mockResolvedValue({ tools: [], client: { callTool: vi.fn() } });
});

describe("loadMcpTools — remote connectors are lazy too", () => {
  // A remote handshake was assumed sub-second, so http connectors were dialled
  // eagerly before the first token. Measured against a small public MCP server
  // it is ~0.9-1.7s per connector (initialize + initialized + tools/list, plus
  // TLS), paid on EVERY turn — even when the model calls nothing, and even when
  // progressive disclosure then hides those tools behind find_tool.
  it("serves cached remote tools without dialling at load time", async () => {
    setCachedTools("api", [{ name: "q", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // would hang if called
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(Object.keys(res.tools)).toEqual(["mcp__api__q"]);
    expect(connectMcpServer).not.toHaveBeenCalled();
  });

  it("threads a governance-\"ask\" server's needsApproval into every adapted tool", async () => {
    setCachedTools("api", [{ name: "q", inputSchema: { type: "object", properties: {} } }]);
    setCachedTools("plug", [{ name: "w", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http"), cfg("plug", "http")]);
    const res = await loadMcpTools({
      userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn(),
      serverNeedsApproval: (name) => name === "api",
    });
    expect((res.tools["mcp__api__q"] as unknown as { __needsApproval?: boolean }).__needsApproval).toBe(true);
    expect((res.tools["mcp__plug__w"] as unknown as { __needsApproval?: boolean }).__needsApproval).toBe(false);
  });

  it("does NOT block startup when a remote connector's connect hangs", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // never resolves
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(res.tools).toEqual({}); // cold cache → no tools this turn, but it RETURNED
  });

  it("warms a cold remote connector's cache in the background", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(res.tools).toEqual({}); // nothing offered this turn
    await res.warming;
    expect(getCachedTools("api")).toEqual([{ name: "q" }]);
  });

  it("hangs up after a schema warm instead of holding the session through the stream", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    await res.warming;
    expect(disconnectMcp).toHaveBeenCalledTimes(1);
  });

  it("never creates a sandbox session for a remote warm", async () => {
    // A remote server needs no container. A warm that ensured the session would
    // resurrect a sandbox in the background, after the turn that owned it ended.
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    await res.warming;
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("close() does not wait on a still-running remote warm", async () => {
    // The warm hangs up on its own, so there is nothing to tear down — and the
    // worker must not sit between turns waiting for a slow server.
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // warm never finishes
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    await expect(Promise.race([
      res.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("blocked"), 50)),
    ])).resolves.toBe("closed");
  });

  it("refreshes a stale remote entry behind the turn, while still offering its tools", async () => {
    // A server can gain or lose tools without telling us. Refresh in the
    // background rather than at the TTL boundary — expiring the entry outright
    // would cost one arbitrary turn with the connector missing.
    stampCacheInThePast("api", [{ name: "q", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q2" }], client: { callTool: vi.fn() } });

    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });

    expect(Object.keys(res.tools)).toEqual(["mcp__api__q"]); // this turn: the known set
    await res.warming;
    expect(getCachedTools("api")).toEqual([{ name: "q2" }]); // next turn: the fresh one
  });

  it("does not dial a stale stdio entry — that would spin the sandbox", async () => {
    stampCacheInThePast("plug", [{ name: "scan", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // would hang if called
    const ensureSession = vi.fn();

    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });

    expect(Object.keys(res.tools)).toEqual(["mcp__plug__scan"]);
    expect(connectMcpServer).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("connects on the first tool call, without a session", async () => {
    setCachedTools("api", [{ name: "q", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool } });
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    const caller = (res.tools["mcp__api__q"] as unknown as { __caller: { callTool: (...a: unknown[]) => Promise<unknown> } }).__caller;
    await caller.callTool({ name: "q", arguments: {} }, undefined, {});
    expect(connectMcpServer).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(ensureSession).not.toHaveBeenCalled();
  });
});

describe("loadMcpTools — oauth needs a token", () => {
  it("does NOT eager-connect (or record an error for) an oauth http connector with no stored token", async () => {
    // An unauthenticated OAuth connect is a guaranteed 401 — that's an expected
    // not-signed-in-yet state, not a failure. Attempting it every turn wasted a
    // connect and set a connect-error backoff that then hid the connector for 10
    // min AFTER the user finally signed in (the bug behind "connector didn't work").
    listEnabledServerConfigs.mockResolvedValue([{ ...cfg("api", "http"), authKind: "oauth" }]);
    hasUserTokens.mockResolvedValue(false);
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(connectMcpServer).not.toHaveBeenCalled();
    expect(recordConnectError).not.toHaveBeenCalled();
    expect(res.tools).toEqual({});
  });

  it("warms an oauth http connector once its token exists", async () => {
    listEnabledServerConfigs.mockResolvedValue([{ ...cfg("api", "http"), authKind: "oauth" }]);
    hasUserTokens.mockResolvedValue(true);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    await res.warming;
    expect(connectMcpServer).toHaveBeenCalledTimes(1);
    expect(getCachedTools("api")).toEqual([{ name: "q" }]);
  });
});

describe("loadMcpTools — stdio is lazy", () => {
  it("does NOT block startup when a stdio connector's connect hangs", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // never resolves
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn().mockResolvedValue(undefined) });
    expect(res.tools).toEqual({}); // cold cache → no tools this turn, but it RETURNED
  });

  it("serves cached stdio tools without connecting or ensuring the session at load", async () => {
    setCachedTools("plug", [{ name: "scan", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    connectMcpServer.mockReturnValue(new Promise(() => {})); // would hang if called
    const ensureSession = vi.fn();
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    expect(Object.keys(res.tools)).toEqual(["mcp__plug__scan"]);
    expect(connectMcpServer).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("lazily ensures session and connects when a cached stdio tool is executed", async () => {
    setCachedTools("plug", [{ name: "scan", inputSchema: { type: "object", properties: {} } }]);
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    connectMcpServer.mockResolvedValue({ tools: [{ name: "scan" }], client: { callTool } });
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    const caller = (res.tools["mcp__plug__scan"] as unknown as { __caller: { callTool: (...a: unknown[]) => Promise<unknown> } }).__caller;
    await caller.callTool({ name: "scan", arguments: {} }, undefined, {});
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(connectMcpServer).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("warms a cold stdio connector's tool cache in the background", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "scan" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn().mockResolvedValue(undefined) });
    expect(res.tools).toEqual({}); // nothing offered this turn
    await res.warming;             // background populate finishes
    expect(getCachedTools("plug")).toEqual([{ name: "scan" }]);
  });

  it("records a connect error (for the UI) when a background warm fails, without throwing", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    connectMcpServer.mockRejectedValue(new Error("npx: not found"));
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn().mockResolvedValue(undefined) });
    await res.warming;
    expect(recordConnectError).toHaveBeenCalledWith("u1", "plug", expect.stringContaining("npx"));
  });
});
