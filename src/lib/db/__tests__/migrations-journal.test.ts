import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards the migration journal against the failure that took prod down on
 * 2026-06-22: drizzle's node-postgres migrator applies a migration only when
 * its `when` (folderMillis) is GREATER than the max `created_at` already in
 * the DB — it ignores `idx` order entirely. A migration whose `when` is
 * smaller than an already-applied one is silently skipped on every DB, even
 * a fresh one.
 *
 * `0019_little_pixie` (cutoff/open_weights columns) was generated with a real
 * `Date.now()` that landed BELOW the synthetic future timestamps hand-set on
 * 0016–0018, so it never ran and `catalogLookup`'s SELECT of `cutoff` blew up
 * with "Failed query" in production.
 */
describe("migration journal", () => {
  const journal = JSON.parse(
    readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };

  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  // The core drizzle invariant: `when` must strictly increase with `idx`.
  // A non-increasing step means the lower-`when` migration is unreachable.
  it("has strictly increasing `when` timestamps in idx order", () => {
    let prev = -Infinity;
    let prevTag = "<start>";
    for (const e of entries) {
      expect(
        e.when,
        `${e.tag} (when=${e.when}) must be > ${prevTag} (when=${prev}); ` +
          `drizzle skips any migration whose \`when\` is <= an applied one`,
      ).toBeGreaterThan(prev);
      prev = e.when;
      prevTag = e.tag;
    }
  });

  // Catches the ROOT cause: hand-set timestamps far in the future. A 7-day
  // window tolerates the existing synthetic ~3-day-ahead stamps (0016–0019,
  // which prod's cemented `created_at` forces us to keep) while still flagging
  // a grossly future date (months ahead) that would silently shadow real
  // future migrations. The window self-deactivates as wall-clock catches up.
  it("has no `when` grossly in the future", () => {
    const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const ceiling = Date.now() + WINDOW_MS;
    for (const e of entries) {
      expect(
        e.when,
        `${e.tag} (when=${e.when}) is more than 7 days in the future; ` +
          `a synthetic future timestamp shadows later migrations`,
      ).toBeLessThan(ceiling);
    }
  });
});
