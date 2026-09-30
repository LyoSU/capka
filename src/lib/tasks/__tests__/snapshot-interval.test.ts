import { describe, it, expect } from "vitest";
import { snapshotIntervalMs } from "../runner";

// Every mid-stream snapshot rewrites the whole reply, so the cadence decides how many
// bytes a turn writes: at a fixed 1s it grows with the square of the turn's length.
describe("snapshotIntervalMs", () => {
  it("keeps the 1s cadence for an ordinary reply", () => {
    expect(snapshotIntervalMs(0)).toBe(1000);
    expect(snapshotIntervalMs(64_000)).toBe(1000);
  });

  it("stretches in proportion to the snapshot once it outgrows 64 KB", () => {
    expect(snapshotIntervalMs(96_000)).toBe(1500);
    expect(snapshotIntervalMs(112_000)).toBe(1750);
  });

  // A client resuming mid-stream re-fetches the whole chat every 250ms until a
  // snapshot covers the deltas it holds, so however large the reply gets, a snapshot
  // is never older than this.
  it("never waits more than 2s", () => {
    expect(snapshotIntervalMs(128_000)).toBe(2000);
    expect(snapshotIntervalMs(50_000_000)).toBe(2000);
  });

  // Replays saveSnapshot's gate against a reply that grows steadily (a tool-heavy turn
  // piling results into `parts`), checked on every ~100ms flush.
  it("holds the write rate near 64 KB/s while the snapshot grows", () => {
    const growthPerSec = 16_000;
    const written = (intervalOf: (bytes: number) => number, seconds: number) => {
      let total = 0;
      let lastAt = -Infinity;
      let wait = 0;
      for (let t = 0; t <= seconds * 1000; t += 100) {
        if (t - lastAt < wait) continue;
        const size = (growthPerSec * t) / 1000;
        total += size;
        lastAt = t;
        wait = intervalOf(size);
      }
      return total;
    };
    // 8s reaches 128 KB, where the cap takes over.
    expect(written(snapshotIntervalMs, 8) / 8).toBeLessThan(64_000 * 1.25);
    // Past the cap the fixed cadence it replaced writes nearly twice as much.
    expect(written(() => 1000, 60)).toBeGreaterThan(written(snapshotIntervalMs, 60) * 1.8);
  });
});
