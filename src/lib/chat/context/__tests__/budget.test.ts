import { describe, it, expect } from "vitest";
import { contextBudget, compactAt, COMPACT_THRESHOLD, DEFAULT_CONTEXT_LENGTH } from "@/lib/chat/context/budget";
import { toolClearTrigger } from "@/lib/chat/context/provider-edits";

describe("contextBudget", () => {
  it("clamps the effective limit to the admin cap, below the model's window", () => {
    // Model advertises 1M, but the admin capped users at 200k.
    const b = contextBudget({ usedTokens: 175_000, modelContextLength: 1_000_000, adminCap: 200_000 });
    expect(b.effectiveLimit).toBe(200_000);
    expect(b.fraction).toBeCloseTo(0.875, 5);
    // The reserve is taken from the CAPPED window: 200k - 30k, not 1M - 150k.
    expect(b.compactAt).toBe(170_000);
    expect(b.shouldCompact).toBe(true);
  });

  it("uses the model window when no admin cap is set", () => {
    const b = contextBudget({ usedTokens: 50_000, modelContextLength: 200_000, adminCap: null });
    expect(b.effectiveLimit).toBe(200_000);
    expect(b.shouldCompact).toBe(false); // 25% — plenty of room
  });

  it("falls back to the default when neither the catalog nor an overflow has named a window", () => {
    const b = contextBudget({ usedTokens: 10_000, modelContextLength: null, adminCap: null });
    expect(b.effectiveLimit).toBe(DEFAULT_CONTEXT_LENGTH);
    // Where today's off-catalog models cluster; the first overflow corrects it.
    expect(DEFAULT_CONTEXT_LENGTH).toBe(128_000);
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

  it("triggers exactly at the reserve, not a token before", () => {
    expect(contextBudget({ usedTokens: 170_000, modelContextLength: 200_000 }).shouldCompact).toBe(true);
    expect(contextBudget({ usedTokens: 169_999, modelContextLength: 200_000 }).shouldCompact).toBe(false);
  });
});

describe("compactAt", () => {
  // window → trigger. Old flat 75%: 24k / 96k / 150k / 750k / (unknown) 96k.
  it.each([
    [32_768, 16_768], // 16k floor: 4.9k would be less than one large file read
    [128_000, 108_800], // 15%
    [200_000, 170_000],
    [1_000_000, 850_000], // 150k free, not 250k
    [16_000, 13_600], // too small to give up 16k: the share alone, never a trigger at 0
  ])("a %i-token window compacts at %i", (window, at) => {
    expect(compactAt(window)).toBe(at);
  });

  it("applies to the default window when the model's is unknown", () => {
    expect(contextBudget({ usedTokens: 0, modelContextLength: null }).compactAt).toBe(compactAt(DEFAULT_CONTEXT_LENGTH));
  });

  it("never fires before the tool-clearing trigger, so clearing stays the cheaper relief", () => {
    for (let w = 8_000; w <= 2_000_000; w += 1_000) expect(compactAt(w)).toBeGreaterThanOrEqual(toolClearTrigger(w));
  });

  it("keeps the summary floor at or below the trigger on every window, so a kept summary cannot re-trip it", () => {
    for (let w = 8_000; w <= 2_000_000; w += 1_000) expect(w * COMPACT_THRESHOLD).toBeLessThanOrEqual(compactAt(w));
  });
});
