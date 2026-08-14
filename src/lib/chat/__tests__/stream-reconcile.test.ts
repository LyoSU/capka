import { describe, it, expect } from "vitest";
import { classifyStreamEvent, planGapDrain } from "../stream-reconcile";

describe("classifyStreamEvent", () => {
  it("applies an event from a legacy publisher that carries no seq", () => {
    // Telegram bot / new_message / older workers don't stamp seq — those must
    // keep working exactly as before, so we never gate them.
    expect(classifyStreamEvent(5, undefined)).toBe("apply");
  });

  it("ignores an event already covered by the snapshot (seq <= applied)", () => {
    // The DB snapshot we reconciled from already includes this seq, or NOTIFY
    // replayed it — applying again would duplicate text.
    expect(classifyStreamEvent(5, 5)).toBe("ignore");
    expect(classifyStreamEvent(5, 3)).toBe("ignore");
  });

  it("applies the next contiguous event (seq === applied + 1)", () => {
    expect(classifyStreamEvent(5, 6)).toBe("apply");
  });

  it("reconciles when there is a gap (seq > applied + 1)", () => {
    // We missed events — reconnected mid-stream, or a NOTIFY was dropped. Pull a
    // fresh DB snapshot rather than appending onto a stale prefix.
    expect(classifyStreamEvent(5, 8)).toBe("reconcile");
  });

  it("treats applied=-1 as 'nothing applied yet': seq 0 starts the stream", () => {
    // A fresh message: task:start carries seq 0 and must be applied to create it.
    expect(classifyStreamEvent(-1, 0)).toBe("apply");
  });

  it("reconciles a first delta that arrives before any snapshot (reconnect)", () => {
    // Remounted mid-stream: a live delta (seq 50) lands before loadHistory seeds
    // applied — the gap pulls the full snapshot in.
    expect(classifyStreamEvent(-1, 50)).toBe("reconcile");
  });
});

// The gap buffer is what makes a reconcile CONVERGE. The snapshot the reload
// returns is up to ~1s stale (saveSnapshot throttles to 1/s) while deltas publish
// ~10/s, so adopting the snapshot alone lands the client straight back in a gap.
// Holding the gapped events and replaying the ones the snapshot doesn't cover is
// what closes the distance to the live stream.
describe("planGapDrain", () => {
  const ev = (messageId: string, seq: number | undefined, text = "") => ({ messageId, seq, text });

  it("drops events the snapshot already covers", () => {
    const { apply, keep } = planGapDrain(
      [ev("m1", 4), ev("m1", 5)],
      new Map([["m1", 5]]),
    );
    expect(apply).toEqual([]);
    expect(keep).toEqual([]);
  });

  it("replays the events the snapshot does not cover, in order", () => {
    const { apply, keep } = planGapDrain(
      [ev("m1", 4, "d"), ev("m1", 5, "e"), ev("m1", 6, "f")],
      new Map([["m1", 3]]),
    );
    expect(apply.map((e) => e.text)).toEqual(["d", "e", "f"]);
    expect(keep).toEqual([]);
  });

  it("mixes both: skips the covered prefix, replays the rest", () => {
    const { apply, keep } = planGapDrain(
      [ev("m1", 4, "d"), ev("m1", 5, "e"), ev("m1", 6, "f")],
      new Map([["m1", 5]]),
    );
    expect(apply.map((e) => e.text)).toEqual(["f"]);
    expect(keep).toEqual([]);
  });

  it("keeps everything when the snapshot is still behind the hole", () => {
    // The lost event was seq 4, but the snapshot only covers 3 and the buffer
    // starts at 5 — replaying now would paint text over a hole. Keep the buffer
    // and reload again once a fresher snapshot exists.
    const { apply, keep } = planGapDrain(
      [ev("m1", 5, "e"), ev("m1", 6, "f")],
      new Map([["m1", 3]]),
    );
    expect(apply).toEqual([]);
    expect(keep.map((e) => e.text)).toEqual(["e", "f"]);
  });

  it("stops at the first still-gapped event and keeps the tail in order", () => {
    // 4 applies; 6 is past a hole (5 never arrived) — 6 and everything after it
    // stay buffered so the retry replays them contiguously.
    const { apply, keep } = planGapDrain(
      [ev("m1", 4, "d"), ev("m1", 6, "f"), ev("m1", 7, "g")],
      new Map([["m1", 3]]),
    );
    expect(apply.map((e) => e.text)).toEqual(["d"]);
    expect(keep.map((e) => e.text)).toEqual(["f", "g"]);
  });

  it("replays an event from a publisher that stamps no seq", () => {
    // Same rule as classifyStreamEvent: never gate a legacy publisher.
    const { apply } = planGapDrain([ev("m1", undefined, "x")], new Map());
    expect(apply.map((e) => e.text)).toEqual(["x"]);
  });

  it("treats a message with no cursor as 'nothing applied yet'", () => {
    const { apply, keep } = planGapDrain([ev("m2", 0, "start"), ev("m2", 1, "a")], new Map());
    expect(apply.map((e) => e.text)).toEqual(["start", "a"]);
    expect(keep).toEqual([]);
  });
});

// End-to-end resume contract between the runner's streamSeq rule and the client's
// classify+apply. This is the regression guard for the duplication bug: the
// runner persists `parts` EAGERLY but bumps `seq` LAZILY, so a snapshot's content
// can include text that hasn't been published yet (still buffered). The runner
// folds those pending publishes into streamSeq; the client must then IGNORE those
// deltas when they arrive, so resumed content is the full reply with no dup.
describe("resume reconciliation (runner streamSeq ⇄ client classify)", () => {
  type Delta = { seq: number; text: string };

  /** Replay published deltas onto a snapshot the way the hook does: adopt the
   *  snapshot's content + applied=streamSeq, then classify each live delta. */
  function resume(snapshotContent: string, streamSeq: number, liveDeltas: Delta[]): string {
    let content = snapshotContent;
    let applied = streamSeq;
    for (const d of liveDeltas) {
      const action = classifyStreamEvent(applied, d.seq);
      if (action === "ignore") continue;
      // "reconcile" would re-pull the snapshot; not exercised in this ordered case.
      expect(action).toBe("apply");
      content += d.text;
      applied = d.seq;
    }
    return content;
  }

  it("resumes a clean snapshot without dropping or duplicating tail deltas", () => {
    // Snapshot covers seq 1..3 ("abc"); deltas 4,5 still to come.
    const result = resume("abc", 3, [
      { seq: 4, text: "d" },
      { seq: 5, text: "e" },
    ]);
    expect(result).toBe("abcde");
  });

  it("does NOT duplicate text the snapshot captured before it was published", () => {
    // The bug: snapshot content already includes "d" (eager parts), and the
    // runner folded that pending publish into streamSeq (3 -> 4). When delta
    // seq=4 ("d") finally publishes, the client must ignore it (already covered),
    // then apply seq=5 ("e"). Without the streamSeq fold, "d" would double.
    const result = resume("abcd", 4, [
      { seq: 4, text: "d" }, // the buffered run, now published — must be ignored
      { seq: 5, text: "e" },
    ]);
    expect(result).toBe("abcde");
  });
});
