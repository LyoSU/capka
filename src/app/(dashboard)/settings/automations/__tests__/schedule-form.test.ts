import { describe, it, expect } from "vitest";
import { toForm, toTriggerArgs } from "../schedule-form";

const TZ = "Europe/Kyiv";

describe("automation schedule form — reading a stored trigger", () => {
  it("recognizes the three shapes it can write", () => {
    expect(toForm({ kind: "schedule", cron: "30 7 * * *", timezone: TZ }, "UTC"))
      .toMatchObject({ freq: "daily", time: "07:30", timezone: TZ });
    expect(toForm({ kind: "schedule", cron: "0 9 * * 1", timezone: TZ }, "UTC"))
      .toMatchObject({ freq: "weekly", time: "09:00", weekday: "1" });
    expect(toForm({ kind: "schedule", cron: "0 9 15 * *", timezone: TZ }, "UTC"))
      .toMatchObject({ freq: "monthly", time: "09:00", dayOfMonth: "15" });
  });

  it("pads a single-digit hour and minute back into HH:MM", () => {
    expect(toForm({ kind: "schedule", cron: "5 8 * * *", timezone: TZ }, "UTC").time).toBe("08:05");
  });

  it("keeps an expression it cannot represent instead of flattening it", () => {
    // Each of these would lose meaning as one of the four simple frequencies —
    // a step, a list, a month field, a day February doesn't always have.
    for (const cron of ["*/15 * * * *", "0 9 * * 1,3", "0 9 1 3 *", "0 9 31 * *"]) {
      const form = toForm({ kind: "schedule", cron, timezone: TZ }, "UTC");
      expect(form).toMatchObject({ freq: "custom", cron });
    }
  });

  it("falls back to the browser zone only when the trigger carries none", () => {
    expect(toForm({ kind: "schedule", cron: "0 9 * * *", timezone: "" }, "UTC").timezone).toBe("UTC");
    expect(toForm({ kind: "schedule", cron: "0 9 * * *", timezone: TZ }, "UTC").timezone).toBe(TZ);
  });

  it("drops the seconds from a one-off so datetime-local accepts it", () => {
    expect(toForm({ kind: "once", at: "2026-08-20T22:15:00", timezone: TZ }, "UTC"))
      .toMatchObject({ freq: "once", at: "2026-08-20T22:15" });
  });
});

describe("automation schedule form — writing it back", () => {
  it("round-trips every shape it claims to understand", () => {
    for (const cron of ["30 7 * * *", "0 9 * * 1", "0 9 15 * *"]) {
      const args = toTriggerArgs(toForm({ kind: "schedule", cron, timezone: TZ }, "UTC"));
      expect(args).toEqual({ cron, timezone: TZ });
    }
  });

  it("restores the seconds a one-off is stored with", () => {
    const args = toTriggerArgs(toForm({ kind: "once", at: "2026-08-20T22:15:00", timezone: TZ }, "UTC"));
    expect(args).toEqual({ once_at: "2026-08-20T22:15:00", timezone: TZ });
  });
});
