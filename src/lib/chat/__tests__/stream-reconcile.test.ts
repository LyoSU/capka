import { describe, it, expect } from "vitest";
import { classifyStreamEvent } from "../stream-reconcile";

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
