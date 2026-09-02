import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The periodic §11.5 witness, as a UNIT — no database, because the interesting behavior is
 * which warnings come out and a test that needed real divergence could not produce the
 * diverged case at all (the dual-write path is written not to diverge).
 *
 * Two cases and they are the pair: a clean sweep must be SILENT, or the line becomes noise
 * an operator learns to scroll past, and a diverged one must carry BOTH directions, because
 * which side holds the extra membership is the whole diagnosis.
 */
import { log } from "@/lib/log";
import { sweepContainsParity, type ContainsParity } from "../edges";

const clean: ContainsParity = { ok: true, onlyInNoteClaims: [], onlyInEdges: [] };

afterEach(() => vi.restoreAllMocks());

describe("sweepContainsParity", () => {
  it("warns once per diverged space, carrying both directions", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await sweepContainsParity({
      liveSpaceIds: async () => ["space-clean", "space-diverged"],
      check: async (spaceId) =>
        spaceId === "space-diverged"
          ? { ok: false, onlyInNoteClaims: ["n1:c1"], onlyInEdges: ["n2:c2", "n2:c3"] }
          : clean,
    });
    // ONE line, not two: the clean space in the same sweep says nothing.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("vault contains parity diverged", {
      spaceId: "space-diverged",
      onlyInNoteClaims: 1,
      onlyInEdges: 2,
      onlyInNoteClaimsSample: ["n1:c1"],
      onlyInEdgesSample: ["n2:c2", "n2:c3"],
    });
  });

  it("bounds the line at 20 ids a side while keeping the counts exact", async () => {
    // The size of a wholesale divergence is the size of the log line, and nothing repairs
    // it, so the same line would repeat every six hours until a release. A count is what
    // says how bad it is; a sample is what says where to start looking.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const many = Array.from({ length: 1000 }, (_, i) => `n${i}:c${i}`);
    await sweepContainsParity({
      liveSpaceIds: async () => ["big"],
      check: async () => ({ ok: false, onlyInNoteClaims: many, onlyInEdges: many }),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [, ctx] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(ctx.onlyInNoteClaims).toBe(1000);
    expect(ctx.onlyInEdges).toBe(1000);
    expect(ctx.onlyInNoteClaimsSample).toHaveLength(20);
    expect(ctx.onlyInEdgesSample).toHaveLength(20);
    // The sample is the HEAD of the list, not an arbitrary slice, so two readings of the
    // same unrepaired divergence name the same rows.
    expect(ctx.onlyInNoteClaimsSample).toEqual(many.slice(0, 20));
  });

  it("is silent when every live space agrees, and asks each of them", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const asked: string[] = [];
    await sweepContainsParity({
      liveSpaceIds: async () => ["a", "b", "c"],
      check: async (spaceId) => {
        asked.push(spaceId);
        return clean;
      },
    });
    expect(warn).not.toHaveBeenCalled();
    // The control on the silence: it is silence about three answers, not silence from a
    // sweep that never ran.
    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("keeps going when one space cannot be read, and says which one", async () => {
    // A control that stops at the first unreadable space reports on the spaces before it
    // and is SILENT about the rest - and silence from this job reads as agreement, which
    // is the one wrong answer it must never give.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await sweepContainsParity({
      liveSpaceIds: async () => ["bad", "later"],
      check: async (spaceId) => {
        if (spaceId === "bad") throw new Error("boom");
        return { ok: false, onlyInNoteClaims: ["n1:c1"], onlyInEdges: [] };
      },
    });
    expect(error).toHaveBeenCalledWith("vault contains parity check failed", {
      spaceId: "bad",
      err: "Error: boom",
    });
    // The space AFTER the failure was still checked and still reported.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("vault contains parity diverged", {
      spaceId: "later",
      onlyInNoteClaims: 1,
      onlyInEdges: 0,
      onlyInNoteClaimsSample: ["n1:c1"],
      onlyInEdgesSample: [],
    });
  });
});
