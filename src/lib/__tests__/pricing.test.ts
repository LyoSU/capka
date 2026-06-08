import { describe, it, expect } from "vitest";
import { costUsd, PRICING } from "../pricing";

describe("costUsd", () => {
  it("charges the catalog input price for 1M input tokens", () => {
    const price = PRICING["claude-opus-4"].input;
    expect(costUsd("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(price, 6);
  });

  it("sums input and output at catalog rates", () => {
    const { input, output } = PRICING["claude-opus-4"];
    const got = costUsd("claude-opus-4-8", { inputTokens: 2_000_000, outputTokens: 500_000 });
    expect(got).toBeCloseTo(input * 2 + output * 0.5, 6);
  });

  it("prefers the longest matching prefix", () => {
    // claude-3-5-haiku must not be priced as claude-3 (opus-tier).
    const got = costUsd("claude-3-5-haiku-20241022", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(got).toBeCloseTo(PRICING["claude-3-5-haiku"].input, 6);
  });

  it("returns null for an unknown model", () => {
    expect(costUsd("totally-unknown-model", { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it("treats cached input tokens at a discounted rate when provided", () => {
    const { input } = PRICING["claude-opus-4"];
    // cached tokens billed at 10% of input rate
    const got = costUsd("claude-opus-4-8", { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 });
    expect(got).toBeCloseTo(input * 0.1, 6);
  });
});
