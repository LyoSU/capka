import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The "New" badge is driven by `models.first_seen_at`, and the property that
 * matters is the negative one: a NULL date means the row predates the column, so
 * it must read as NOT new. Get that backwards and every model in a 3000-row
 * catalog wears the badge on the deploy that adds the column — which is also why
 * the migration blanks what `ADD COLUMN ... DEFAULT now()` writes.
 */
const rows = vi.hoisted(() => ({ models: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(rows.models);
  return { db: { select: () => chain } };
});
vi.mock("@/lib/settings", () => ({ getBlockPrivateProviderUrls: async () => false }));

import { listProviderModels, invalidateModelsCache } from "@/lib/providers/list-models";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const row = (id: string, firstSeenAt: Date | null) => ({
  id, source: "openrouter", displayName: id, group: "Probe", icon: null,
  contextLength: 1000, inputPrice: null, outputPrice: null, cacheReadPrice: null, cacheWritePrice: null,
  capabilities: { vision: false, tools: true, reasoning: false },
  cutoff: null, openWeights: false, enabled: true, featured: false,
  firstSeenAt, updatedAt: new Date(),
});

// No key and a dead network: the live OpenRouter call fails, so the curated
// catalog above is what gets returned — the path this suite is about.
beforeEach(() => {
  rows.models = [];
  // The list is memoised per credential set for five minutes, and every case here
  // shares one (keyless OpenRouter) — without this each test after the first would
  // assert against the first one's rows and fail as if the mapping were broken.
  invalidateModelsCache();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

const byId = async () =>
  new Map((await listProviderModels({ provider: "openrouter" })).map((m) => [m.id, m]));

describe("the New badge", () => {
  it("flags a model the catalog first saw inside the window", async () => {
    rows.models = [row("brand/fresh", daysAgo(2))];
    expect((await byId()).get("brand/fresh")?.isNew).toBe(true);
  });

  it("does not flag one first seen before the window", async () => {
    rows.models = [row("brand/settled", daysAgo(60))];
    expect((await byId()).get("brand/settled")?.isNew).toBe(false);
  });

  it("treats an unknown first-seen date as not new", async () => {
    // Every row that predates the migration. If this ever returns true, the whole
    // catalog announces itself as new at once.
    rows.models = [row("brand/legacy", null)];
    expect((await byId()).get("brand/legacy")?.isNew).toBe(false);
  });

  it("marks the boundary honestly rather than optimistically", async () => {
    rows.models = [row("brand/edge", daysAgo(14.1))];
    expect((await byId()).get("brand/edge")?.isNew).toBe(false);
  });
});
