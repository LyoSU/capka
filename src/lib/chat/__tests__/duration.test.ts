import { describe, it, expect } from "vitest";
import { formatShortDuration, formatLiveElapsed } from "../duration";

// A stand-in for next-intl's translator, rendering the same shapes the real
// `chat.duration` messages do — so a key renamed in one place and not the other
// shows up here as an "unknown key" rather than as a silently wrong label.
const uk = (key: string, v?: Record<string, string | number>) => {
  if (key === "sec") return `${v!.s} с`;
  if (key === "minSec") return `${v!.m} хв ${v!.s} с`;
  throw new Error(`unknown key: ${key}`);
};

describe("formatShortDuration", () => {
  it("stays in seconds below a minute", () => {
    expect(formatShortDuration(0, uk)).toBe("0 с");
    expect(formatShortDuration(8_400, uk)).toBe("8 с");
    expect(formatShortDuration(59_400, uk)).toBe("59 с");
  });

  it("switches to minutes at the boundary and pads the seconds", () => {
    expect(formatShortDuration(60_000, uk)).toBe("1 хв 00 с");
    expect(formatShortDuration(65_000, uk)).toBe("1 хв 05 с");
    expect(formatShortDuration(92_000, uk)).toBe("1 хв 32 с");
    expect(formatShortDuration(125_000, uk)).toBe("2 хв 05 с");
  });

  // 59.6s rounds to 60, which must render as "1 хв 00 с" and never as "60 с" —
  // the seconds branch is chosen from the ROUNDED value for exactly this reason.
  it("never prints sixty seconds", () => {
    expect(formatShortDuration(59_600, uk)).toBe("1 хв 00 с");
  });

  it("clamps a negative span rather than printing a minus", () => {
    expect(formatShortDuration(-5_000, uk)).toBe("0 с");
  });
});

describe("formatLiveElapsed", () => {
  // Withheld under 5s on purpose: putting a number on a fast operation measures
  // it for the user and thereby makes it feel slow.
  it("says nothing for the first five seconds", () => {
    expect(formatLiveElapsed(0, uk)).toBe("");
    expect(formatLiveElapsed(4_900, uk)).toBe("");
  });

  it("floors rather than rounds, so the clock never shows a second not yet elapsed", () => {
    expect(formatLiveElapsed(5_000, uk)).toBe("5 с");
    expect(formatLiveElapsed(5_900, uk)).toBe("5 с");
    expect(formatLiveElapsed(59_900, uk)).toBe("59 с");
    expect(formatLiveElapsed(92_400, uk)).toBe("1 хв 32 с");
  });
});
