import { describe, it, expect } from "vitest";
import { resolveConflictName, leaseRenewMs } from "../bridge";
import { conflictName } from "../plan";

/**
 * The two decisions the bridge makes that are not handle I/O, so they can be tested
 * without a browser: which name a conflict copy is written under, and how often the
 * sync lease has to be renewed.
 */

const at = new Date(2026, 8, 7, 14, 32, 4);
/** A predicate over a fixed set of paths, standing in for "the manifests plus the
 *  real directory" the sync asks. */
const taken = (...names: string[]) => async (n: string) => names.includes(n);

describe("resolveConflictName", () => {
  it("uses the plain dated name when nothing is there", async () => {
    expect(await resolveConflictName("report.docx", at, taken())).toBe("report.conflict-2026-09-07-143204.docx");
  });

  // The defect: the copy was written with a plain createWritable(), which truncates.
  // A second conflict on report.docx in the same second landed on the first copy and
  // destroyed the version that had just been "kept".
  it("steps past a name that already exists rather than overwriting it", async () => {
    const first = conflictName("report.docx", at);
    expect(await resolveConflictName("report.docx", at, taken(first))).toBe("report.conflict-2026-09-07-143204-2.docx");
  });

  it("keeps stepping while the counter names are taken too", async () => {
    const busy = taken(
      conflictName("report.docx", at, 1),
      conflictName("report.docx", at, 2),
      conflictName("report.docx", at, 3),
    );
    expect(await resolveConflictName("report.docx", at, busy)).toBe("report.conflict-2026-09-07-143204-4.docx");
  });

  // Aborting loses nothing: the merge base is only written at the end of a sync, so
  // the next run starts from the same ancestor and retries. Handing back a colliding
  // name would destroy a file instead.
  it("refuses to return a colliding name when every candidate is taken", async () => {
    await expect(resolveConflictName("report.docx", at, async () => true)).rejects.toThrow(/free name/);
  });

  it("asks about the exact path it would write, directory included", async () => {
    const asked: string[] = [];
    await resolveConflictName("a/b/report.docx", at, async (n) => { asked.push(n); return false; });
    expect(asked).toEqual(["a/b/report.conflict-2026-09-07-143204.docx"]);
  });
});

describe("leaseRenewMs", () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);
  const inMs = (ms: number) => new Date(now + ms).toISOString();

  it("renews several times over the lease's life, so missed ticks are survivable", () => {
    // A hidden tab's timers are throttled to roughly one a minute, so the interval
    // has to leave room for a few of them to be skipped.
    const ttl = 10 * 60 * 1000;
    const every = leaseRenewMs(inMs(ttl), now);
    expect(ttl / every).toBeGreaterThanOrEqual(5);
  });

  it("never hammers the endpoint on a short lease", () => {
    expect(leaseRenewMs(inMs(10_000), now)).toBe(15_000);
    expect(leaseRenewMs(inMs(-60_000), now)).toBe(15_000);
  });

  it("caps the interval so a very long lease is still renewed regularly", () => {
    expect(leaseRenewMs(inMs(24 * 60 * 60 * 1000), now)).toBe(120_000);
  });

  it("falls back to a minute when the server sent no usable expiry", () => {
    expect(leaseRenewMs(undefined, now)).toBe(60_000);
    expect(leaseRenewMs("not a date", now)).toBe(60_000);
  });
});
