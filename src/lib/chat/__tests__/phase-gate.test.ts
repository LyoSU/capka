import { describe, it, expect } from "vitest";
import { gatePhase } from "../phase-gate";

// The gate exists to satisfy two demands that pull against each other: a phase
// label must never blink, and it must never leave a hole where a word was. It
// resolves them with two different clocks — a REVEAL threshold before a label may
// appear, and a DWELL floor after it has. Neither alone is enough: reveal stops
// the blink on the way in, dwell stops it on the way out.

const T = 10_000; // an arbitrary "now" — nothing here depends on the epoch.
const base = { revealMs: 1500, dwellMs: 1200 };
const at = (over: Partial<Parameters<typeof gatePhase>[0]>) =>
  gatePhase({ phase: null, phaseSince: T, shown: null, shownAt: 0, now: T, ...over }, base);

describe("gatePhase — appearing", () => {
  it("says nothing about a phase that just started", () => {
    const r = at({ phase: "sandbox", phaseSince: T });
    expect(r.shown).toBeNull();
  });

  it("asks to be re-checked exactly when the phase would become old enough", () => {
    expect(at({ phase: "sandbox", phaseSince: T }).recheckIn).toBe(1500);
    expect(at({ phase: "sandbox", phaseSince: T - 900 }).recheckIn).toBe(600);
  });

  it("shows a phase that has outlasted the reveal threshold", () => {
    const r = at({ phase: "sandbox", phaseSince: T - 1500 });
    expect(r.shown).toBe("sandbox");
    expect(r.shownAt).toBe(T);
    expect(r.recheckIn).toBeNull();
  });

  // The whole point: a phase that comes and goes inside the threshold is never
  // drawn at all, so there is nothing to blink.
  it("never shows a phase that ended before the threshold", () => {
    const started = at({ phase: "preparing", phaseSince: T });
    expect(started.shown).toBeNull();
    const ended = at({ phase: null, phaseSince: T + 400, shown: started.shown, shownAt: started.shownAt });
    expect(ended.shown).toBeNull();
    expect(ended.recheckIn).toBeNull();
  });
});

describe("gatePhase — disappearing", () => {
  it("holds a label whose phase ended too soon after it appeared", () => {
    const r = at({ phase: null, shown: "sandbox", shownAt: T - 100 });
    expect(r.shown).toBe("sandbox");
    expect(r.recheckIn).toBe(1100);
  });

  it("clears the label once it has had its full dwell", () => {
    const r = at({ phase: null, shown: "sandbox", shownAt: T - 1200 });
    expect(r.shown).toBeNull();
    expect(r.recheckIn).toBeNull();
  });
});

describe("gatePhase — swapping one phase for another", () => {
  // Both clocks apply: the incoming phase must be old enough AND the outgoing
  // label must have had its dwell. Taking only one of them lets a label flash.
  it("waits for whichever of the two clocks is slower", () => {
    // Incoming is brand new (1500 to go), outgoing has 1100 of dwell left.
    expect(at({ phase: "sandbox", phaseSince: T, shown: "preparing", shownAt: T - 100 }).recheckIn).toBe(1500);
    // Incoming is already old, but the outgoing label only just appeared.
    expect(at({ phase: "sandbox", phaseSince: T - 3000, shown: "preparing", shownAt: T - 100 }).recheckIn).toBe(1100);
  });

  it("keeps showing the outgoing label while it waits, never a gap", () => {
    expect(at({ phase: "sandbox", phaseSince: T, shown: "preparing", shownAt: T - 100 }).shown).toBe("preparing");
  });

  it("swaps once both clocks have run out", () => {
    const r = at({ phase: "sandbox", phaseSince: T - 3000, shown: "preparing", shownAt: T - 2000 });
    expect(r.shown).toBe("sandbox");
    expect(r.shownAt).toBe(T);
  });
});

describe("gatePhase — the invariant", () => {
  // Stated once, as a property rather than a case: whatever the input, a label
  // that is on screen cannot be replaced or removed before its dwell is up.
  it("never lets a visible label be taken away inside its dwell", () => {
    const inputs = [null, "queued", "preparing", "sandbox"] as const;
    for (const phase of inputs) {
      for (const age of [0, 1, 600, 1199]) {
        const r = at({ phase, phaseSince: T - 9999, shown: "preparing", shownAt: T - age });
        expect(r.shown, `phase=${phase} age=${age}`).toBe("preparing");
      }
    }
  });

  it("leaves a settled state completely alone, asking for no further checks", () => {
    expect(at({ phase: null, shown: null })).toEqual({ shown: null, shownAt: 0, recheckIn: null });
    const held = at({ phase: "sandbox", phaseSince: T - 5000, shown: "sandbox", shownAt: T - 5000 });
    expect(held).toEqual({ shown: "sandbox", shownAt: T - 5000, recheckIn: null });
  });
});
