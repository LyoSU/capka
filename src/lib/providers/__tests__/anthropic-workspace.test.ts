import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A user-scoped Anthropic key (sk-ant-usr-…) gets HTTP 400 from /v1/models unless
 * the request names its workspace. Two properties matter: the header is sent when
 * (and only when) a workspace ID is configured, and the model list is cached per
 * workspace — one shared entry would serve one workspace's list to another.
 */
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve([]);
  // The price-book lookup awaits the chain straight after `.where()`.
  chain.then = (resolve: (rows: unknown[]) => void) => resolve([]);
  return { db: { select: () => chain } };
});
vi.mock("@/lib/settings", () => ({ getBlockPrivateProviderUrls: async () => false }));

import { listProviderModels, invalidateModelsCache } from "@/lib/providers/list-models";

const fetchMock = vi.fn();
const headersOf = (call: number) => (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>;

beforeEach(() => {
  invalidateModelsCache();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ data: [{ id: "claude-x", display_name: "Claude X" }] }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("Anthropic workspace header", () => {
  it("sends anthropic-workspace-id when a workspace is configured", async () => {
    await listProviderModels({ provider: "anthropic", apiKey: "k", workspaceId: "wrkspc_abc" });
    expect(headersOf(0)["anthropic-workspace-id"]).toBe("wrkspc_abc");
  });

  it("omits the header for a regular key", async () => {
    await listProviderModels({ provider: "anthropic", apiKey: "k" });
    expect(headersOf(0)).not.toHaveProperty("anthropic-workspace-id");
  });

  it("caches per workspace, not per key alone", async () => {
    await listProviderModels({ provider: "anthropic", apiKey: "k", workspaceId: "wrkspc_a" });
    await listProviderModels({ provider: "anthropic", apiKey: "k", workspaceId: "wrkspc_b" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await listProviderModels({ provider: "anthropic", apiKey: "k", workspaceId: "wrkspc_a" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
