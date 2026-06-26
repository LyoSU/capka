import { describe, it, expect, vi, beforeEach } from "vitest";

// loadMcpTools must spin up the sandbox container BEFORE connecting a stdio
// connector (its server is `docker exec`'d in, and plugin files are written via
// exec). With the lazy-sandbox change, forgetting this silently skips every
// stdio plugin. These tests lock that contract.

const listEnabledServerConfigs = vi.fn();
const connectMcpServer = vi.fn();

vi.mock("../service", () => ({ listEnabledServerConfigs: (...a: unknown[]) => listEnabledServerConfigs(...a) }));
vi.mock("../client", () => ({
  connectMcpServer: (...a: unknown[]) => connectMcpServer(...a),
  disconnectMcp: vi.fn(),
}));
vi.mock("../adapt", () => ({ adaptMcpTool: vi.fn(), mcpToolName: (s: string, t: string) => `mcp__${s}__${t}` }));
vi.mock("../connect-errors", () => ({ recordConnectError: vi.fn(), clearConnectError: vi.fn(), recentlyFailed: vi.fn(() => false) }));
vi.mock("../oauth/provider", () => ({ McpOAuthProvider: class {} }));
vi.mock("../plugin-runtime", () => ({ needsPluginRoot: () => false, resolvePluginRoot: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getBlockPrivateProviderUrls: async () => false }));

import { loadMcpTools } from "../load";

const cfg = (name: string, transport: "stdio" | "http") => ({
  id: name, name, transport, enabled: true, authKind: "token",
  url: transport === "http" ? "https://e.x/mcp" : null,
  command: transport === "stdio" ? "server" : undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  connectMcpServer.mockResolvedValue({ tools: [], client: {} });
});

describe("loadMcpTools sandbox session", () => {
  it("ensures the session when a stdio connector is present", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT ensure the session when only http connectors exist (stays lazy)", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("api", "http")]);
    const ensureSession = vi.fn().mockResolvedValue(undefined);
    await loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession });
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("does not throw when ensureSession fails — stdio connectors are skipped, not fatal", async () => {
    listEnabledServerConfigs.mockResolvedValue([cfg("plug", "stdio")]);
    const ensureSession = vi.fn().mockRejectedValue(new Error("controller down"));
    await expect(
      loadMcpTools({ userId: "u1", projectId: null, sessionKey: "s1", ensureSession }),
    ).resolves.toBeDefined();
  });
});
