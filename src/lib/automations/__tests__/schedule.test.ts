import { describe, it, expect } from "vitest";
import { nextOccurrenceAfter, nextOccurrences, type AutomationTrigger } from "../schedule";

const kyivWeekly: AutomationTrigger = { kind: "schedule", cron: "0 9 * * 1", timezone: "Europe/Kyiv" };

describe("nextOccurrenceAfter", () => {
  it("finds next Monday 09:00 Kyiv (EEST, UTC+3)", () => {
    // Wed 2026-07-01 12:00 UTC → next Mon is 2026-07-06 09:00 Kyiv = 06:00 UTC
    const next = nextOccurrenceAfter(kyivWeekly, new Date("2026-07-01T12:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-06T06:00:00.000Z");
  });

  it("stays 09:00 local across the DST fall-back (Kyiv switches 2026-10-25)", () => {
    const daily: AutomationTrigger = { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Kyiv" };
    // Sat 2026-10-24: still summer time → 09:00 Kyiv = 06:00 UTC
    const before = nextOccurrenceAfter(daily, new Date("2026-10-24T00:00:00Z"));
    expect(before?.toISOString()).toBe("2026-10-24T06:00:00.000Z");
    // Mon 2026-10-26: winter time → 09:00 Kyiv = 07:00 UTC
    const after = nextOccurrenceAfter(daily, new Date("2026-10-26T00:00:00Z"));
    expect(after?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
  });

  it("once: returns the moment while it's in the future, null after it passed", () => {
    const once: AutomationTrigger = { kind: "once", at: "2026-08-01T12:00:00Z" };
    expect(nextOccurrenceAfter(once, new Date("2026-07-01T00:00:00Z"))?.toISOString()).toBe("2026-08-01T12:00:00.000Z");
    expect(nextOccurrenceAfter(once, new Date("2026-08-01T12:00:01Z"))).toBeNull();
  });

  it("throws on an invalid cron expression", () => {
    expect(() => nextOccurrenceAfter({ kind: "schedule", cron: "not a cron", timezone: "Europe/Kyiv" }, new Date())).toThrow();
  });
});

describe("nextOccurrences", () => {
  it("returns n consecutive occurrences", () => {
    const three = nextOccurrences(kyivWeekly, 3, new Date("2026-07-01T12:00:00Z"));
    expect(three.map((d) => d.toISOString())).toEqual([
      "2026-07-06T06:00:00.000Z",
      "2026-07-13T06:00:00.000Z",
      "2026-07-20T06:00:00.000Z",
    ]);
  });

  it("once yields at most one occurrence", () => {
    expect(nextOccurrences({ kind: "once", at: "2026-08-01T12:00:00Z" }, 3, new Date("2026-07-01T00:00:00Z"))).toHaveLength(1);
  });
});
