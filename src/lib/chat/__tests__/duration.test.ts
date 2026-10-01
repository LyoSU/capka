import { describe, it, expect } from "vitest";
import { formatShortDuration, formatLiveElapsed } from "../duration";

// A stand-in for next-intl's translator, rendering the same shapes the real
// `chat.duration` messages do — so a key renamed in one place and not the other
// shows up here as an "unknown key" rather than as a silently wrong label.
const t = (key: string, v?: Record<string, string | number>) => {
  if (key === "sec") return `${v!.s} s`;
  if (key === "minSec") return `${v!.m} m ${v!.s} s`;
  if (key === "min") return `${v!.m} m`;
  if (key === "hourMin") return `${v!.h} h ${v!.m} m`;
  throw new Error(`unknown key: ${key}`);
};

describe("formatShortDuration", () => {
  it("stays in seconds below a minute", () => {
    expect(formatShortDuration(0, t)).toBe("0 s");
    expect(formatShortDuration(8_400, t)).toBe("8 s");
    expect(formatShortDuration(59_400, t)).toBe("59 s");
  });

  it("switches to minutes at the boundary and pads the seconds", () => {
    expect(formatShortDuration(60_000, t)).toBe("1 m 00 s");
    expect(formatShortDuration(65_000, t)).toBe("1 m 05 s");
    expect(formatShortDuration(92_000, t)).toBe("1 m 32 s");
    expect(formatShortDuration(125_000, t)).toBe("2 m 05 s");
  });

  // 59.6s rounds to 60, which must render as "1 m 00 s" and never as "60 s" —
  // the seconds branch is chosen from the ROUNDED value for exactly this reason.
  it("never prints sixty seconds", () => {
    expect(formatShortDuration(59_600, t)).toBe("1 m 00 s");
  });

  it("clamps a negative span rather than printing a minus", () => {
    expect(formatShortDuration(-5_000, t)).toBe("0 s");
  });
});

describe("long spans", () => {
  it("drops the seconds from ten minutes", () => {
    expect(formatShortDuration(599_000, t)).toBe("9 m 59 s");
    expect(formatShortDuration(600_000, t)).toBe("10 m");
    expect(formatShortDuration(752_000, t)).toBe("12 m");
    expect(formatShortDuration(3_599_000, t)).toBe("59 m");
  });

  it("switches to hours and minutes from an hour", () => {
    expect(formatShortDuration(3_600_000, t)).toBe("1 h 0 m");
    expect(formatShortDuration(3_900_000, t)).toBe("1 h 5 m");
    expect(formatLiveElapsed(7_500_000, t)).toBe("2 h 5 m");
  });
});

describe("formatLiveElapsed", () => {
  // Withheld under 5s on purpose: putting a number on a fast operation measures
  // it for the user and thereby makes it feel slow.
  it("says nothing for the first five seconds", () => {
    expect(formatLiveElapsed(0, t)).toBe("");
    expect(formatLiveElapsed(4_900, t)).toBe("");
  });

  it("floors rather than rounds, so the clock never shows a second not yet elapsed", () => {
    expect(formatLiveElapsed(5_000, t)).toBe("5 s");
    expect(formatLiveElapsed(5_900, t)).toBe("5 s");
    expect(formatLiveElapsed(59_900, t)).toBe("59 s");
    expect(formatLiveElapsed(92_400, t)).toBe("1 m 32 s");
  });
});
