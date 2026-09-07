import { describe, it, expect } from "vitest";
import { parseTriggerArgs, assertMinInterval, humanizeSchedule } from "../controls/automations";

/** A wall-clock `once_at` a year out, derived from the clock instead of written
 *  down. `parseTriggerArgs` rejects a once_at in the past, so any literal future
 *  date in this file is a time bomb: the original `2026-08-01T12:00:00` was in the
 *  future when this test was written and started failing the day it wasn't.
 *  Only the happy-path case needs it — the timezone and both/neither cases throw
 *  before the past check is ever reached. */
const futureWallClock = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"
})();

describe("parseTriggerArgs", () => {
  it("builds a schedule trigger from cron + timezone", () => {
    expect(parseTriggerArgs({ cron: "0 9 * * 1", timezone: "Europe/Kyiv" })).toEqual(
      { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" });
  });
  it("builds a once trigger from once_at + timezone", () => {
    expect(parseTriggerArgs({ once_at: futureWallClock, timezone: "Europe/Kyiv" })).toEqual(
      { kind: "once", at: futureWallClock, timezone: "Europe/Kyiv" });
  });
  it("rejects a once_at without a valid timezone (a bare wall-clock time is ambiguous)", () => {
    expect(() => parseTriggerArgs({ once_at: "2026-08-01T12:00:00" })).toThrow(/timezone/i);
    expect(() => parseTriggerArgs({ once_at: "2026-08-01T12:00:00", timezone: "Not/AZone" })).toThrow(/timezone/i);
  });
  it("rejects a once_at already in the past", () => {
    expect(() => parseTriggerArgs({ once_at: "2000-01-01T00:00:00", timezone: "Europe/Kyiv" })).toThrow(/past/i);
  });
  it("builds a webhook trigger, which needs the timezone for the daily run limit", () => {
    expect(parseTriggerArgs({ webhook: true, timezone: "Europe/Kyiv" })).toEqual(
      { kind: "webhook", timezone: "Europe/Kyiv" });
    // No clock, but still a day boundary to count runs against — so the zone is
    // as required here as it is for cron.
    expect(() => parseTriggerArgs({ webhook: true })).toThrow(/timezone/i);
  });
  it("rejects both/neither", () => {
    expect(() => parseTriggerArgs({})).toThrow(/cron, once_at, or webhook/);
    expect(() => parseTriggerArgs({ cron: "0 9 * * 1", timezone: "x", once_at: "2026-08-01T12:00:00Z" })).toThrow();
    // Two trigger kinds at once is the same mistake as none: which one wins would
    // decide when someone's automation actually runs.
    expect(() => parseTriggerArgs({ cron: "0 9 * * 1", timezone: "Europe/Kyiv", webhook: true })).toThrow(/exactly one/i);
  });
  it("rejects an interval under the minimum", () => {
    // "every 5 minutes" with min 60 → friendly error naming the minimum
    expect(() => assertMinInterval({ kind: "schedule", cron: "*/5 * * * *", timezone: "Europe/Kyiv" }, 60))
      .toThrow(/60/);
  });
});

describe("humanizeSchedule", () => {
  it("shows the next dates in the user's locale", () => {
    const s = humanizeSchedule({ kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" }, "uk", new Date("2026-07-01T12:00:00Z"));
    expect(s.nextDates).toHaveLength(3);
    expect(s.perMonth).toBeGreaterThanOrEqual(4); // ~4-5 Mondays / month
  });
});
