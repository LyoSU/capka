import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Three connections, one of them behind a dead endpoint. The picker must still be
 * served the other two — and must be TOLD which one failed, because "your model
 * is not in this list" and "your model's connection did not answer" are the same
 * observation and opposite conclusions. Without the second fact the UI reported a
 * timed-out tunnel as a retired model, offered no retry, and pointed an empty chat
 * at "start a new chat".
 */
const { requireSession, resolveEnabledConfigs, listProviderModels, getProviderKeyMode, recentModelRefs } =
  vi.hoisted(() => ({
    requireSession: vi.fn(),
    resolveEnabledConfigs: vi.fn(),
    listProviderModels: vi.fn(),
    getProviderKeyMode: vi.fn(),
    recentModelRefs: vi.fn(),
  }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});
vi.mock("@/lib/providers/resolve", () => ({
  resolveEnabledConfigs,
  labelEnabledConfigs: (configs: { id: string; provider: string }[]) =>
    new Map(configs.map((c) => [c.id, c.provider])),
}));
vi.mock("@/lib/providers/list-models", () => ({
  listProviderModels,
  applySharedGovernance: async (m: unknown) => m,
}));
vi.mock("@/lib/providers/recent-models", () => ({ recentModelRefs }));
vi.mock("@/lib/settings", () => ({
  getProviderKeyMode,
  getMasterKey: async () => "mk",
}));
vi.mock("@/lib/crypto", () => ({ decrypt: () => "key" }));
vi.mock("@/lib/models/catalog", () => ({ syncModelCatalog: async () => {} }));
vi.mock("@/lib/db", () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } }));

import { GET } from "@/app/api/models/route";

const model = (id: string) => ({
  id, name: id, provider: "x", context: 1000, pricing: { prompt: 0, completion: 0 },
  capabilities: { vision: false, tools: true, reasoning: false },
});

const config = (id: string, provider = "litellm") => ({
  id, provider, apiKey: "enc", baseUrl: `https://${id}.example/v1`, isShared: false, iconSlug: null,
});

const call = () => GET(new Request("http://x/api/models"));

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue({ userId: "u1" });
  getProviderKeyMode.mockReset().mockResolvedValue("own");
  recentModelRefs.mockReset().mockResolvedValue([]);
  listProviderModels.mockReset();
  resolveEnabledConfigs.mockReset();
});

describe("GET /api/models — one connection down", () => {
  it("still serves the healthy connections and names the one that failed", async () => {
    resolveEnabledConfigs.mockResolvedValue([config("alive"), config("dead")]);
    listProviderModels.mockImplementation(async ({ baseUrl }: { baseUrl: string }) => {
      if (baseUrl.includes("dead")) throw new Error("connect ETIMEDOUT");
      return [model("brand/works")];
    });

    const body = await (await call()).json();

    expect(body.models.map((m: { id: string }) => m.id)).toEqual(["brand/works"]);
    expect(body.failedConfigs).toEqual(["dead"]);
    // `error` speaks only for the all-or-nothing case; two thirds of an offering
    // is a success, and reporting it as an error would blank the whole picker.
    expect(body.error).toBeUndefined();
  });

  it("reports no failures when every connection answers", async () => {
    resolveEnabledConfigs.mockResolvedValue([config("a"), config("b")]);
    listProviderModels.mockResolvedValue([model("brand/m")]);

    const body = await (await call()).json();

    expect(body.failedConfigs).toEqual([]);
  });

  it("still reports an error when nothing at all loaded", async () => {
    resolveEnabledConfigs.mockResolvedValue([config("dead1"), config("dead2")]);
    listProviderModels.mockRejectedValue(new Error("down"));

    const body = await (await call()).json();

    expect(body.models).toEqual([]);
    expect(body.error).toBeTruthy();
    // Both are named, so the UI can tell a total outage from a retired model too.
    expect(body.failedConfigs).toEqual(["dead1", "dead2"]);
  });
});
