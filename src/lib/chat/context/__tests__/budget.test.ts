import { describe, it, expect } from "vitest";
import { contextBudget, COMPACT_THRESHOLD, DEFAULT_CONTEXT_LENGTH } from "@/lib/chat/context/budget";

describe("contextBudget", () => {
  it("clamps the effective limit to the admin cap, below the model's window", () => {
    // Model advertises 1M, but the admin capped users at 200k.
    const b = contextBudget({ usedTokens: 160_000, modelContextLength: 1_000_000, adminCap: 200_000 });
    expect(b.effectiveLimit).toBe(200_000);
    expect(b.fraction).toBeCloseTo(0.8, 5);
    expect(b.shouldCompact).toBe(true); // 80% > 75% threshold
  });

  it("uses the model window when no admin cap is set", () => {
    const b = contextBudget({ usedTokens: 50_000, modelContextLength: 200_000, adminCap: null });
    expect(b.effectiveLimit).toBe(200_000);
    expect(b.shouldCompact).toBe(false); // 25% — plenty of room
  });

  it("falls back to a conservative default when the catalog reports no window", () => {
    const b = contextBudget({ usedTokens: 10_000, modelContextLength: null, adminCap: null });
    expect(b.effectiveLimit).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it("never exceeds the model window even if the admin cap is larger", () => {
    // Admin cap of 500k is meaningless on a 128k model.
    const b = contextBudget({ usedTokens: 0, modelContextLength: 128_000, adminCap: 500_000 });
    expect(b.effectiveLimit).toBe(128_000);
  });

  it("reports fraction over 1 and shouldCompact when already past the window", () => {
    const b = contextBudget({ usedTokens: 210_000, modelContextLength: 200_000, adminCap: null });
    expect(b.fraction).toBeGreaterThan(1);
    expect(b.shouldCompact).toBe(true);
  });

  it("triggers exactly at the threshold", () => {
    const b = contextBudget({ usedTokens: COMPACT_THRESHOLD * 200_000, modelContextLength: 200_000 });
    expect(b.shouldCompact).toBe(true);
  });
});
