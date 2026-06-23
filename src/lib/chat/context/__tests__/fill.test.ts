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
});
