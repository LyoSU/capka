import { describe, it, expect } from "vitest";
import { deriveContextFill } from "@/lib/chat/context/fill";

const reply = (used: number, window: number) => ({
  metadata: { usage: { input: used, output: 0, cached: 0 }, contextWindow: window },
});
const user = () => ({ metadata: {} });
const checkpoint = () => ({ metadata: { compaction: { summary: "s", summarizedUpTo: "x" } } });

describe("deriveContextFill", () => {
  it("returns null for an empty conversation", () => {
    expect(deriveContextFill([])).toBeNull();
  });

  it("reads usage + window from the most recent reply that reported them", () => {
    expect(deriveContextFill([reply(10, 100), user()])).toEqual({ used: 10, window: 100 });
  });

  it("hides (null) right after a compaction — the checkpoint is the leaf, so the last reply's usage is stale", () => {
    // The reply that triggered compaction still says 100%, but the checkpoint now
    // sits after it: the real post-compaction size isn't known until the next turn.
    expect(deriveContextFill([reply(100, 100), checkpoint()])).toBeNull();
  });

  it("resumes once a fresh turn lands after the checkpoint", () => {
    expect(deriveContextFill([reply(100, 100), checkpoint(), user(), reply(40, 100)])).toEqual({
      used: 40,
      window: 100,
    });
  });

  it("prefers contextTokens (last LLM call's real prompt size) over the turn's cumulative usage sum", () => {
    // A multi-step tool-calling turn racks up cache-read tokens on EVERY step
    // (e.g. 9 LLM calls re-reading a growing prefix), so usage.input+cached can
    // land far above the model's actual window even though the real context at
    // the end of the turn is nowhere near full. contextTokens is the last
    // step's actual prompt size and must win when present.
    const multiStepReply = {
      metadata: {
        usage: { input: 781_796, output: 11_698, cached: 5_529_472 },
        contextTokens: 900_000,
        contextWindow: 2_000_000,
      },
    };
    expect(deriveContextFill([multiStepReply])).toEqual({ used: 900_000, window: 2_000_000 });
  });
});
