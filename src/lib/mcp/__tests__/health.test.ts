import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Connectors are declared from the schema cache and dialled lazily, so a
 * just-added remote connector would otherwise contribute nothing to the FIRST
 * turn after being saved. The health probe already connects and lists tools —
 * so it seeds the cache, and the tools are there from the first message.
 */
const { connectMcpServer, disconnectMcp } = vi.hoisted(() => ({
  connectMcpServer: vi.fn(),
  disconnectMcp: vi.fn(async () => {}),
}));
vi.mock("../client", () => ({ connectMcpServer, disconnectMcp }));
vi.mock("../oauth/store", () => ({ hasUserTokens: vi.fn(async () => true) }));
vi.mock("../oauth/provider", () => ({ McpOAuthProvider: class {} }));
vi.mock("../connect-errors", () => ({ getConnectError: vi.fn(() => undefined) }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/settings", () => ({
  getMasterKey: async () => "k",
  getBlockPrivateProviderUrls: async () => false,
}));

import { probeConfig } from "../health";
import { getCachedTools, clearCachedTools } from "../tool-cache";

beforeEach(() => {
  vi.clearAllMocks();
  disconnectMcp.mockResolvedValue(undefined);
  connectMcpServer.mockResolvedValue({
    tools: [{ name: "search" }],
    client: { getServerVersion: () => ({ name: "Example" }) },
  });
  clearCachedTools("s1");
  clearCachedTools("probe");
});

describe("probeConfig", () => {
  it("seeds the schema cache for a stored connector", async () => {
    const health = await probeConfig({ id: "s1", name: "example", url: "https://host.example/mcp" }, false);
    expect(health).toMatchObject({ status: "ok", toolCount: 1 });
    expect(getCachedTools("s1")).toEqual([{ name: "search" }]);
  });

  it("caches nothing for the add form's pre-save probe", async () => {
    // No row exists yet, so there is no id to key on — and the caller passes a
    // placeholder name. Caching under that name would put a junk entry in a cache
    // the runtime looks up by `id ?? name`.
    await probeConfig({ name: "probe", url: "https://host.example/mcp" }, false);
    expect(getCachedTools("probe")).toBeUndefined();
  });

  it("hangs up after probing", async () => {
    await probeConfig({ id: "s1", name: "example", url: "https://host.example/mcp" }, false);
    expect(disconnectMcp).toHaveBeenCalledTimes(1);
  });
});
