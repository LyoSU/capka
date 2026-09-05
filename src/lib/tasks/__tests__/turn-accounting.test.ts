import { describe, expect, it } from "vitest";
import { foldTurnHalves, type TurnHalf } from "../turn-accounting";

const run: TurnHalf = {
  usage: { input: 100, output: 20, cached: 50 },
  costUsd: 0.004,
  costSource: "catalog",
  durationMs: 3_000,
  reasoningMs: 1_200,
};

describe("foldTurnHalves", () => {
  it("hands back an ordinary turn untouched", () => {
    // The overwhelming majority of turns have no earlier half: the metadata they
    // persist must be exactly what it was before continuations were folded at all.
    expect(foldTurnHalves(run, {})).toBe(run);
  });

  it("sums tokens, cost and time across the two halves of an approval turn", () => {
    const folded = foldTurnHalves(run, {
      usage: { input: 400, output: 80, cached: 200 },
      costUsd: 0.011,
      costSource: "catalog",
      durationMs: 9_000,
      reasoningMs: 4_000,
    });
    expect(folded.usage).toEqual({ input: 500, output: 100, cached: 250 });
    expect(folded.costUsd).toBeCloseTo(0.015, 10);
    expect(folded.durationMs).toBe(12_000);
    expect(folded.reasoningMs).toBe(4_000 + 1_200);
  });

  it("keeps the display-only splits omitted while they are zero on both halves", () => {
    const folded = foldTurnHalves(
      { usage: { input: 1, output: 1, cached: 0 }, durationMs: 1 },
      { usage: { input: 1, output: 1, cached: 0 }, durationMs: 1 },
    );
    expect(folded.usage).not.toHaveProperty("cacheWrite");
    expect(folded.usage).not.toHaveProperty("reasoning");
  });

  it("emits a split as soon as either half reports it", () => {
    const folded = foldTurnHalves(
      { usage: { input: 1, output: 1, cached: 0, cacheWrite: 7 }, durationMs: 1 },
      { usage: { input: 1, output: 1, cached: 0, reasoning: 3 }, durationMs: 1 },
    );
    expect(folded.usage).toMatchObject({ cacheWrite: 7, reasoning: 3 });
  });

  it("keeps costSource provider only when BOTH halves were billed by the provider", () => {
    const providerRun: TurnHalf = { ...run, costSource: "provider" };
    expect(foldTurnHalves(providerRun, { usage: run.usage, costUsd: 1, costSource: "provider", durationMs: 1 }).costSource)
      .toBe("provider");
    // A catalog estimate anywhere in the sum makes the total an estimate.
    expect(foldTurnHalves(providerRun, { usage: run.usage, costUsd: 1, costSource: "catalog", durationMs: 1 }).costSource)
      .toBe("catalog");
  });

  it("downgrades to an estimate when one half's cost is missing from the sum", () => {
    // Half of a real figure is not the billed amount, so it must not claim to be.
    const folded = foldTurnHalves({ ...run, costSource: "provider" }, { usage: run.usage, durationMs: 500 });
    expect(folded.costUsd).toBeCloseTo(0.004, 10);
    expect(folded.costSource).toBe("catalog");
  });

  it("omits cost entirely when neither half priced the turn", () => {
    const folded = foldTurnHalves({ usage: run.usage, durationMs: 1 }, { usage: run.usage, durationMs: 1 });
    expect(folded.costUsd).toBeUndefined();
    expect(folded.costSource).toBeUndefined();
  });

  it("still reports the earlier half when the continuation itself billed nothing", () => {
    // A continuation cancelled before its first call has no usage of its own; the
    // turn's tokens must not vanish from the popover because of that.
    const folded = foldTurnHalves({ durationMs: 40 }, { usage: { input: 9, output: 2, cached: 0 }, costUsd: 0.001, costSource: "catalog", durationMs: 60, reasoningMs: 10 });
    expect(folded.usage).toEqual({ input: 9, output: 2, cached: 0 });
    expect(folded.costUsd).toBeCloseTo(0.001, 10);
    expect(folded.durationMs).toBe(100);
  });

  it("never carries contextTokens, which is a last-call snapshot rather than a total", () => {
    expect(foldTurnHalves(run, { usage: run.usage, durationMs: 1 })).not.toHaveProperty("contextTokens");
  });

  it("sums the request counts, because the popover answers for the MESSAGE", () => {
    // An approval continuation asks the provider again on the same message row, so
    // the count the reader sees has to cover both halves — the same reason the
    // tokens are summed and `contextTokens` is not.
    const folded = foldTurnHalves(
      { llmCalls: 2, usage: { input: 10, output: 5, cached: 0 } },
      { llmCalls: 3, usage: { input: 1, output: 1, cached: 0 } },
    );
    expect(folded.llmCalls).toBe(5);
  });

  it("keeps a lone half's count untouched", () => {
    expect(foldTurnHalves({ llmCalls: 4 }, {}).llmCalls).toBe(4);
  });
});
