import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedTools,
  setCachedTools,
  clearCachedTools,
  cachedToolsAreStale,
  SCHEMA_TTL_MS,
} from "../tool-cache";

const tools = [{ name: "scan", description: "scan", inputSchema: { type: "object", properties: {} } }];

describe("mcp tool-cache — one cache per process", () => {
  afterEach(() => {
    clearCachedTools("dup");
    vi.resetModules();
  });

  it("survives a second evaluation of the module in the same process", async () => {
    // Next.js can evaluate a module more than once per process (server + route
    // graphs), which is why worker.ts, realtime.ts and queue.ts all keep their
    // singletons on globalThis. A module-level Map here meant the second copy
    // started empty — so every turn missed the cache and re-dialled every
    // connector on the time-to-first-token path, the exact cost this cache exists
    // to avoid.
    const first = await import("../tool-cache");
    first.setCachedTools("dup", tools);

    vi.resetModules();
    const second = await import("../tool-cache");

    expect(second).not.toBe(first); // a genuinely re-evaluated module
    expect(second.getCachedTools("dup")).toEqual(tools);
  });
});

describe("mcp tool-cache staleness", () => {
  beforeEach(() => clearCachedTools("srv"));
  afterEach(() => vi.useRealTimers());

  it("reports a fresh entry as not stale", () => {
    setCachedTools("srv", tools);
    expect(cachedToolsAreStale("srv")).toBe(false);
  });

  it("reports an entry past the TTL as stale", () => {
    vi.useFakeTimers();
    setCachedTools("srv", tools);
    vi.advanceTimersByTime(SCHEMA_TTL_MS + 1);
    expect(cachedToolsAreStale("srv")).toBe(true);
  });

  it("still serves a stale entry — staleness triggers a refresh, it does not hide tools", () => {
    // Dropping the entry at the TTL would cost one whole turn without that
    // connector's tools, at a random moment in a conversation. Stale-while-
    // revalidate keeps them declared and refreshes behind the turn.
    vi.useFakeTimers();
    setCachedTools("srv", tools);
    vi.advanceTimersByTime(SCHEMA_TTL_MS + 1);
    expect(getCachedTools("srv")).toEqual(tools);
  });

  it("treats an unknown server as not stale (there is nothing to revalidate)", () => {
    expect(cachedToolsAreStale("srv")).toBe(false);
  });
});

describe("mcp tool-cache", () => {
  beforeEach(() => clearCachedTools("srv"));

  it("returns undefined for an unknown server", () => {
    expect(getCachedTools("srv")).toBeUndefined();
  });

  it("stores and returns a server's tool schemas", () => {
    setCachedTools("srv", tools);
    expect(getCachedTools("srv")).toEqual(tools);
  });

  it("clears a server's cached tools", () => {
    setCachedTools("srv", tools);
    clearCachedTools("srv");
    expect(getCachedTools("srv")).toBeUndefined();
  });
});
