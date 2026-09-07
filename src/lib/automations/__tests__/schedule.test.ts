import { describe, it, expect } from "vitest";
import { localDayOf, nextOccurrenceAfter, nextOccurrences, type AutomationTrigger } from "../schedule";

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
    const once: AutomationTrigger = { kind: "once", at: "2026-08-01T12:00:00Z", timezone: "Europe/Kyiv" };
    expect(nextOccurrenceAfter(once, new Date("2026-07-01T00:00:00Z"))?.toISOString()).toBe("2026-08-01T12:00:00.000Z");
    expect(nextOccurrenceAfter(once, new Date("2026-08-01T12:00:01Z"))).toBeNull();
  });

  it("once: a bare wall-clock time is read in the trigger's timezone, not UTC", () => {
    // "22:15" in Kyiv summer (UTC+3) is 19:15 UTC — the whole point of the fix:
    // the server runs in UTC but the user meant their own 22:15.
    const once: AutomationTrigger = { kind: "once", at: "2026-07-02T22:15:00", timezone: "Europe/Kyiv" };
    expect(nextOccurrenceAfter(once, new Date("2026-07-02T00:00:00Z"))?.toISOString()).toBe("2026-07-02T19:15:00.000Z");
  });

  it("once: an explicit offset/Z on `at` wins over the timezone", () => {
    const once: AutomationTrigger = { kind: "once", at: "2026-07-02T22:15:00Z", timezone: "Europe/Kyiv" };
    expect(nextOccurrenceAfter(once, new Date("2026-07-02T00:00:00Z"))?.toISOString()).toBe("2026-07-02T22:15:00.000Z");
  });

  it("once: a legacy row without a timezone falls back to UTC (old behavior)", () => {
    const once = { kind: "once", at: "2026-07-02T22:15:00" } as AutomationTrigger;
    expect(nextOccurrenceAfter(once, new Date("2026-07-02T00:00:00Z"))?.toISOString()).toBe("2026-07-02T22:15:00.000Z");
  });

  it("once: throws on an unparseable datetime", () => {
    expect(() => nextOccurrenceAfter({ kind: "once", at: "not a date", timezone: "Europe/Kyiv" }, new Date())).toThrow();
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
    expect(nextOccurrences({ kind: "once", at: "2026-08-01T12:00:00Z", timezone: "Europe/Kyiv" }, 3, new Date("2026-07-01T00:00:00Z"))).toHaveLength(1);
  });
});

describe("webhook trigger", () => {
  // The row's next_run_at comes from this function, and NULL is what keeps a
  // webhook automation out of the scheduler's claim (`next_run_at <= now` is
  // never true for NULL). A date here would make every webhook row fire on a
  // clock it never asked for.
  it("has no next occurrence, ever", () => {
    expect(nextOccurrenceAfter({ kind: "webhook", timezone: "Europe/Kyiv" }, new Date())).toBeNull();
    expect(nextOccurrences({ kind: "webhook", timezone: "Europe/Kyiv" }, 3)).toEqual([]);
  });
});

describe("localDayOf — the day a run limit counts against", () => {
  // 22:30 UTC is already tomorrow in Kyiv and still today in New York. The whole
  // point of carrying a timezone on every trigger kind (webhook included) is that
  // the cap rolls over on the OWNER's midnight, not the server's.
  const at = new Date("2026-07-01T22:30:00Z");

  it("reads the date in the trigger's zone, not the server's", () => {
    expect(localDayOf({ timezone: "Europe/Kyiv" }, at)).toBe("2026-07-02");
    expect(localDayOf({ timezone: "America/New_York" }, at)).toBe("2026-07-01");
  });

  it("falls back to UTC for a legacy row with no zone, rather than throwing", () => {
    expect(localDayOf({}, at)).toBe("2026-07-01");
    expect(localDayOf({ timezone: "" }, at)).toBe("2026-07-01");
  });

  it("falls back to UTC on an unparseable zone", () => {
    expect(localDayOf({ timezone: "Not/AZone" }, at)).toBe("2026-07-01");
  });
});
