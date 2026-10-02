import { describe, it, expect, vi, afterEach } from "vitest";
import { clearClientModelsCache, fetchModelsShared, putClientModels, readClientModels } from "../model-picker";

const entry = (at: number) => ({ at, models: [], isShared: false, recent: [] });

describe("client models cache", () => {
  afterEach(() => {
    clearClientModelsCache();
    vi.unstubAllGlobals();
  });

  it("is fresh inside the TTL and stale (but still readable) after it", () => {
    putClientModels("active", entry(1_000));
    expect(readClientModels("active", 1_000 + 4 * 60_000)?.fresh).toBe(true);
    const stale = readClientModels("active", 1_000 + 5 * 60_000);
    expect(stale?.fresh).toBe(false);
    expect(stale?.entry.at).toBe(1_000);
    expect(readClientModels("nope")).toBeUndefined();
  });

  it("clearClientModelsCache drops every entry", () => {
    putClientModels("active", entry(Date.now()));
    putClientModels("cfg:a", entry(Date.now()));
    clearClientModelsCache();
    expect(readClientModels("active")).toBeUndefined();
    expect(readClientModels("cfg:a")).toBeUndefined();
  });

  it("is bounded: the oldest entry is evicted past 32 keys", () => {
    for (let i = 0; i < 33; i++) putClientModels(`cfg:${i}`, entry(Date.now()));
    expect(readClientModels("cfg:0")).toBeUndefined();
    expect(readClientModels("cfg:1")).toBeDefined();
    expect(readClientModels("cfg:32")).toBeDefined();
  });

  it("a clear stops later callers joining a request that predates it", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: [{ id: String(++n) }] }))));
    const before = fetchModelsShared("active", { mode: "active" });
    clearClientModelsCache();
    const after = fetchModelsShared("active", { mode: "active" });
    expect(after).not.toBe(before);
    await Promise.all([before, after]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
