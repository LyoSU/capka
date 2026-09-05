import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `resolveAuxTarget` decides where the background passes run. Its whole job is a
 * fallback, and the fallback is the part that must never fail loudly: a setting
 * pointing at a disconnected provider has to cost a chat title nothing.
 *
 * The happy path (a ref that resolves) belongs to `resolveUserModelInfo` and is
 * exercised where that is; what is checked here is every way the answer degrades
 * back to the conversation's own model.
 */
const { getAuxModelRef, warn } = vi.hoisted(() => ({
  getAuxModelRef: vi.fn(async (): Promise<string | null> => null),
  warn: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getAuxModelRef,
  getMasterKey: vi.fn(async () => "k"),
  sharedKeyEnabled: vi.fn(async () => true),
  getModelMaxPrice: vi.fn(async () => 0),
  getBlockPrivateProviderUrls: vi.fn(async () => false),
}));
vi.mock("@/lib/log", () => ({ log: { warn, error: vi.fn(), info: vi.fn() } }));
// Any ref that gets as far as a lookup fails here — which is the disconnected /
// deleted-connection case the fallback exists for.
vi.mock("@/lib/db", () => ({
  db: { select: () => { throw new Error("connection is gone"); } },
}));

import { resolveAuxTarget } from "../resolve";

const turn = {
  model: { modelId: "claude-opus-5" } as never,
  provider: "anthropic",
  modelId: "claude-opus-5",
  configId: "cfg-turn",
  isShared: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuxModelRef.mockResolvedValue(null);
});

describe("resolveAuxTarget", () => {
  it("runs background work on the conversation's own model when nothing is set", async () => {
    await expect(resolveAuxTarget("user-1", turn)).resolves.toBe(turn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the turn's model when the configured one no longer resolves", async () => {
    getAuxModelRef.mockResolvedValue("cfg-gone:some-model");

    await expect(resolveAuxTarget("user-1", turn)).resolves.toEqual(turn);
    // Warned, not thrown: the admin needs to know the setting is stale, the user
    // must not lose their chat title over it.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back when the setting itself cannot be read", async () => {
    getAuxModelRef.mockRejectedValue(new Error("settings table is locked"));

    await expect(resolveAuxTarget("user-1", turn)).resolves.toBe(turn);
  });
});
