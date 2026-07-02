import { describe, it, expect } from "vitest";
import { parseTriggerArgs, assertMinInterval, humanizeSchedule } from "../controls/automations";

describe("parseTriggerArgs", () => {
  it("builds a schedule trigger from cron + timezone", () => {
    expect(parseTriggerArgs({ cron: "0 9 * * 1", timezone: "Europe/Kyiv" })).toEqual(
      { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" });
  });
  it("builds a once trigger from once_at", () => {
    expect(parseTriggerArgs({ once_at: "2026-08-01T12:00:00Z" })).toEqual(
      { kind: "once", at: "2026-08-01T12:00:00Z" });
  });
  it("rejects both/neither", () => {
    expect(() => parseTriggerArgs({})).toThrow(/cron or once_at/);
    expect(() => parseTriggerArgs({ cron: "0 9 * * 1", timezone: "x", once_at: "2026-08-01T12:00:00Z" })).toThrow();
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
