import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStreamRecovery, MAX_GAP_BUFFER } from "../stream-recovery";
import { classifyStreamEvent } from "../stream-reconcile";

type Ev = { messageId: string; seq: number; text: string };

/**
 * A stand-in for the live turn: the runner publishes a delta every 100ms and
 * persists a snapshot when the test says so — every 1s for an ordinary reply, up
 * to every 5s for a large one (snapshotIntervalMs in runner.ts).
 */
function makeTurn() {
  let published = 0;          // highest seq published
  let snapshotSeq = 0;        // what a reload would return (lags, throttled)
  const publishedText = new Map<number, string>();
  return {
    publish(): Ev {
      published += 1;
      publishedText.set(published, `d${published}`);
      return { messageId: "m1", seq: published, text: `d${published}` };
    },
    /** The runner's saveSnapshot: catches the snapshot up to what's published. */
    persist() { snapshotSeq = published; },
    get snapshotSeq() { return snapshotSeq; },
    textUpTo(seq: number) {
      return Array.from({ length: seq }, (_, i) => publishedText.get(i + 1) ?? "").join("");
    },
  };
}

describe("createStreamRecovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reloads even while deltas keep arriving faster than the retry window", async () => {
    // THE REGRESSION. This used to be a trailing debounce, and deltas arrive every
    // ~100ms — inside the window — so every gapped delta re-armed it and the reload
    // never ran once. The reply froze on screen for the rest of the turn.
    const turn = makeTurn();
    const cursors = new Map<string, number>([["m1", 0]]);
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { reloads += 1; cursors.set("m1", turn.snapshotSeq); },
      apply: () => true,
      cursors,
    });

    turn.publish(); // seq 1 — lost in transit

    for (let tick = 0; tick < 50; tick++) {  // 5 seconds of streaming
      recovery.hold(turn.publish());
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(reloads).toBeGreaterThan(0);
  });

  it("catches up to the live stream and keeps up with it afterwards", async () => {
    const turn = makeTurn();
    const cursors = new Map<string, number>([["m1", 0]]);
    let rendered = "";
    const recovery = createStreamRecovery<Ev>({
      // A reload adopts the snapshot: content up to snapshotSeq, cursor with it.
      reload: async () => { rendered = turn.textUpTo(turn.snapshotSeq); cursors.set("m1", turn.snapshotSeq); },
      apply: (e) => { rendered += e.text; return true; },
      cursors,
    });

    turn.publish();          // seq 1 — the lost event
    turn.persist();          // the runner's next snapshot covers the hole

    for (let tick = 0; tick < 20; tick++) {
      const event = turn.publish();
      // The hook's gate: only genuinely gapped events reach the recovery path.
      if (classifyStreamEvent(cursors.get("m1") ?? -1, event.seq) === "apply") {
        cursors.set("m1", event.seq);
        rendered += event.text;
      } else {
        recovery.hold(event);
      }
      await vi.advanceTimersByTimeAsync(100);
      if (tick % 10 === 9) turn.persist();
    }
    await vi.advanceTimersByTimeAsync(1000);

    // Nothing swallowed and nothing doubled: every published delta, exactly once.
    expect(rendered).toBe(turn.textUpTo(21));
    expect(recovery.held).toBe(0);
  });

  it("holds events back while the snapshot is still behind the hole", async () => {
    // The reload lands before the runner persisted past the lost seq — replaying
    // now would paint text over a passage the snapshot doesn't have.
    const cursors = new Map<string, number>([["m1", 3]]);
    const applied: string[] = [];
    let snapshotSeq = 3; // still behind: seq 4 was the lost event
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { cursors.set("m1", snapshotSeq); },
      apply: (e) => { applied.push(e.text); return true; },
      cursors,
    });

    recovery.hold({ messageId: "m1", seq: 5, text: "e" });
    await vi.advanceTimersByTimeAsync(50);
    expect(applied).toEqual([]);
    expect(recovery.held).toBe(1);

    // The runner's next snapshot covers the hole — now the held event replays.
    snapshotSeq = 4;
    await vi.advanceTimersByTimeAsync(300);
    expect(applied).toEqual(["e"]);
    expect(recovery.held).toBe(0);
  });

  it("spaces reloads instead of storming the server", async () => {
    const cursors = new Map<string, number>([["m1", 0]]);
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { reloads += 1; },  // never catches up
      apply: () => true,
      cursors,
    });

    for (let tick = 0; tick < 100; tick++) {   // 1 second of gapped deltas
      recovery.hold({ messageId: "m1", seq: 10 + tick, text: "x" });
      await vi.advanceTimersByTimeAsync(10);
    }

    // ~1s at a 250ms floor — a handful of reloads, not one per event.
    expect(reloads).toBeLessThanOrEqual(6);
    expect(reloads).toBeGreaterThan(0);
  });

  it("backs off while a gap stays open for a large reply's 5s snapshot, then starts over", async () => {
    // Every reload is a full-chat fetch, and on a large reply the snapshot that
    // closes the gap is up to 5s away. At a fixed 250ms that was ~20 reloads of a
    // reply that is, by then, hundreds of KB.
    const turn = makeTurn();
    const cursors = new Map<string, number>([["m1", 0]]);
    let rendered = "";
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { reloads += 1; rendered = turn.textUpTo(turn.snapshotSeq); cursors.set("m1", turn.snapshotSeq); },
      apply: (e) => { rendered += e.text; return true; },
      cursors,
    });
    const tick = async () => {
      const event = turn.publish();
      if (classifyStreamEvent(cursors.get("m1") ?? -1, event.seq) === "apply") {
        cursors.set("m1", event.seq);
        rendered += event.text;
      } else {
        recovery.hold(event);
      }
      await vi.advanceTimersByTimeAsync(100);
    };

    turn.publish();                                  // seq 1 — the lost event
    for (let t = 0; t < 50; t++) await tick();       // 5s before the runner persists
    expect(reloads).toBeLessThanOrEqual(6);
    expect(reloads).toBeGreaterThan(2);

    turn.persist();                                  // the snapshot that covers the hole
    for (let t = 0; t < 21; t++) await tick();       // at most one backed-off spacing (2s)
    expect(rendered).toBe(turn.textUpTo(72));
    expect(recovery.held).toBe(0);

    // The gap closed, so the next one retries from the 250ms floor again.
    const before = reloads;
    turn.publish();                                  // another lost event
    await tick();                                    // gapped: reloads at once
    turn.persist();
    for (let t = 0; t < 3; t++) await tick();        // retried 250ms later, not 2s
    expect(reloads).toBe(before + 2);
    expect(rendered).toBe(turn.textUpTo(77));
    expect(recovery.held).toBe(0);
  });

  it("keeps holding events that could not be applied, in publish order", async () => {
    // The reply row isn't in the client's copy (a reload raced task:start): the
    // events must stay held rather than count as applied and vanish.
    const cursors = new Map<string, number>([["m1", 3]]);
    let rowExists = false;
    const applied: string[] = [];
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { cursors.set("m1", 3); },
      apply: (e) => { if (!rowExists) return false; applied.push(e.text); return true; },
      cursors,
    });

    recovery.hold({ messageId: "m1", seq: 4, text: "d" });
    recovery.hold({ messageId: "m1", seq: 5, text: "e" });
    await vi.advanceTimersByTimeAsync(600);
    expect(applied).toEqual([]);
    expect(recovery.held).toBe(2);

    rowExists = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(applied).toEqual(["d", "e"]);
  });

  it("drops what it holds for a reply whose turn ended", async () => {
    const cursors = new Map<string, number>();
    const applied: string[] = [];
    const recovery = createStreamRecovery<Ev>({
      reload: async () => {},
      apply: (e) => { applied.push(e.text); return true; },
      cursors,
    });

    recovery.hold({ messageId: "m1", seq: 9, text: "late" });
    recovery.drop("m1");                 // task:finish reloaded the final content
    await vi.advanceTimersByTimeAsync(1000);
    // Without the drop, an empty cursor reads as "nothing applied yet" and this
    // would replay onto the finished reply, duplicating text.
    expect(applied).toEqual([]);
  });

  it("forgets the backoff of a reply whose turn ended, so the next gap reloads at once", async () => {
    // The gap never closed before the turn finished: by then its retries had backed
    // off to 2s, with one pending. A gap on the next reply must not wait that out.
    const cursors = new Map<string, number>([["m1", 0]]);
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { reloads += 1; },  // never catches up
      apply: () => true,
      cursors,
    });

    recovery.hold({ messageId: "m1", seq: 10, text: "x" });
    await vi.advanceTimersByTimeAsync(1800);     // reloads at 0, 250, 750, 1750
    expect(reloads).toBe(4);                     // control: backed off, next one at 3750
    recovery.drop("m1");                         // task:finish

    await vi.advanceTimersByTimeAsync(300);
    recovery.hold({ messageId: "m2", seq: 5, text: "y" });
    await vi.advanceTimersByTimeAsync(10);
    expect(reloads).toBe(5);
  });

  it("a reply's finish does not cancel a reload another reply asked for", async () => {
    // A truncated payload holds nothing; it only asks for a reload, which the retry
    // spacing may put off. Another reply finishing in that window must not cancel it.
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({ reload: async () => { reloads += 1; }, apply: () => true, cursors: new Map() });

    recovery.reconcile("m2");
    await vi.advanceTimersByTimeAsync(10);
    recovery.reconcile("m2");                    // inside the spacing: put off
    recovery.drop("m1");                         // another reply's task:finish
    await vi.advanceTimersByTimeAsync(300);
    expect(reloads).toBe(2);

    recovery.reconcile("m2");                    // control: its own finish does cancel it
    recovery.drop("m2");
    await vi.advanceTimersByTimeAsync(300);
    expect(reloads).toBe(2);
  });

  it("reloads again for a truncated payload that arrived while a reload was in flight", async () => {
    // That reload's snapshot may predate the payload, so it cannot stand in for it.
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: () => { reloads += 1; return new Promise<void>((r) => setTimeout(r, 100)); },
      apply: () => true,
      cursors: new Map(),
    });

    recovery.reconcile("m1");
    await vi.advanceTimersByTimeAsync(50);
    recovery.reconcile("m1");
    await vi.advanceTimersByTimeAsync(400);
    expect(reloads).toBe(2);
  });

  it("bounds what it holds when the reload is wedged", async () => {
    const cursors = new Map<string, number>([["m1", 0]]);
    const recovery = createStreamRecovery<Ev>({
      reload: () => new Promise<void>(() => {}), // never resolves
      apply: () => true,
      cursors,
    });

    for (let i = 0; i < MAX_GAP_BUFFER + 50; i++) {
      recovery.hold({ messageId: "m1", seq: 100 + i, text: "x" });
    }
    expect(recovery.held).toBeLessThanOrEqual(MAX_GAP_BUFFER);
  });

  it("stops reloading once disposed", async () => {
    const cursors = new Map<string, number>();
    let reloads = 0;
    const recovery = createStreamRecovery<Ev>({
      reload: async () => { reloads += 1; },
      apply: () => true,
      cursors,
    });
    recovery.hold({ messageId: "m1", seq: 5, text: "x" });
    await vi.advanceTimersByTimeAsync(10);
    recovery.dispose();
    const after = reloads;
    recovery.hold({ messageId: "m1", seq: 6, text: "y" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reloads).toBe(after);
  });
});
