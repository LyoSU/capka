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
const recordConnectError = vi.fn();
const hasUserTokens = vi.fn<(...a: unknown[]) => Promise<boolean>>(() => Promise.resolve(true));

vi.mock("../service", () => ({ listEnabledServerConfigs: (...a: unknown[]) => listEnabledServerConfigs(...a) }));
vi.mock("../client", () => ({
  connectMcpServer: (...a: unknown[]) => connectMcpServer(...a),
  disconnectMcp: vi.fn(),
}));
vi.mock("../adapt", () => ({
  // Capture the caller passed in so a test can exercise the lazy-connect path.
  adaptMcpTool: (client: unknown, server: string, tool: { name: string }) => ({ __caller: client, __server: server, __tool: tool.name }),
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
import { getCachedTools, setCachedTools, clearCachedTools } from "../tool-cache";

const cfg = (name: string, transport: "stdio" | "http") => ({
  id: name, name, transport, enabled: true, authKind: "token",
  url: transport === "http" ? "https://e.x/mcp" : null,
  command: transport === "stdio" ? "server" : undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearCachedTools("plug");
  clearCachedTools("api");
  connectMcpServer.mockResolvedValue({ tools: [], client: { callTool: vi.fn() } });
});

describe("loadMcpTools — http stays eager", () => {
  it("connects http connectors at load time and exposes their tools", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(connectMcpServer).toHaveBeenCalledTimes(1);
    expect(Object.keys(res.tools)).toContain("mcp__api__q");
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

  it("eager-connects an oauth http connector once its token exists", async () => {
    listEnabledServerConfigs.mockResolvedValue([{ ...cfg("api", "http"), authKind: "oauth" }]);
    hasUserTokens.mockResolvedValue(true);
    connectMcpServer.mockResolvedValue({ tools: [{ name: "q" }], client: { callTool: vi.fn() } });
    const res = await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession: vi.fn() });
    expect(connectMcpServer).toHaveBeenCalledTimes(1);
    expect(Object.keys(res.tools)).toContain("mcp__api__q");
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
