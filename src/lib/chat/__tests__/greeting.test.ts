import { describe, it, expect } from "vitest";

import { getMoment, firstName, pickGreeting, type Greeting } from "@/lib/chat/greeting";

// A tiny, fully-controlled catalog so selection is deterministic and doesn't
// depend on whatever the shipped one happens to contain.
const catalog: Greeting[] = [
  { id: "morning", time: ["morning"], text: { uk: "Ранок", en: "Morning" } },
  { id: "morning-name", time: ["morning"], text: { uk: "Привіт, {name}", en: "Hi, {name}" } },
  { id: "evening", time: ["evening"], text: { uk: "Вечір", en: "Evening" } },
  { id: "friday-eve", time: ["evening"], weekdays: [5], text: { uk: "П'ятниця ввечері", en: "Friday eve" } },
];

// 2026-06-08 is a Monday; 2026-06-12 a Friday. Local time via the Date ctor.
const monMorning = new Date(2026, 5, 8, 9, 0); // Mon 09:00
const friEvening = new Date(2026, 5, 12, 19, 0); // Fri 19:00
const satNight = new Date(2026, 5, 13, 23, 30); // Sat 23:30

describe("getMoment", () => {
  it("buckets the hour into time-of-day", () => {
    expect(getMoment(monMorning).time).toBe("morning");
    expect(getMoment(friEvening).time).toBe("evening");
    expect(getMoment(satNight).time).toBe("night");
    expect(getMoment(new Date(2026, 5, 8, 14)).time).toBe("afternoon");
  });

  it("derives season from the month and flags weekends", () => {
    expect(getMoment(monMorning).season).toBe("summer");
    expect(getMoment(new Date(2026, 0, 1)).season).toBe("winter");
    expect(getMoment(monMorning).isWeekend).toBe(false);
    expect(getMoment(satNight).isWeekend).toBe(true);
  });
});

describe("firstName", () => {
  it("takes the first token of a full name", () => {
    expect(firstName("Йосип Любчак")).toBe("Йосип");
  });
  it("rejects empty, email-like, or non-letter junk", () => {
    expect(firstName("")).toBeNull();
    expect(firstName("  ")).toBeNull();
    expect(firstName("user@example.com")).toBeNull();
    expect(firstName("123")).toBeNull();
  });
});

describe("pickGreeting", () => {
  it("only offers lines matching the current moment", () => {
    // rng→0 picks the first eligible line; at Monday morning that's "morning".
    const g = pickGreeting({ now: monMorning, catalog, random: () => 0 });
    expect(g).toBe("Ранок");
  });

  it("excludes {name} lines when no name is known", () => {
    // Force the last eligible line; without a name, morning-name is filtered out
    // so the only morning line left is the plain one.
    const g = pickGreeting({ now: monMorning, catalog, random: () => 0.999 });
    expect(g).toBe("Ранок");
  });

  it("substitutes the first name into a {name} line", () => {
    const g = pickGreeting({ now: monMorning, name: "Олег Петренко", catalog, random: () => 0.999 });
    expect(g).toBe("Привіт, Олег");
  });

  it("respects locale", () => {
    expect(pickGreeting({ now: monMorning, catalog, locale: "en", random: () => 0 })).toBe("Morning");
  });

  it("favours the more specific line when its moment comes", () => {
    // Friday evening: both "evening" and the Friday-evening line are eligible.
    // The specific one carries extra weight, so a midpoint draw lands on it.
    const g = pickGreeting({ now: friEvening, catalog, random: () => 0.99 });
    expect(g).toBe("П'ятниця ввечері");
  });

  it("falls back to any localized line when nothing matches the moment", () => {
    const onlyMorning: Greeting[] = [{ id: "m", time: ["morning"], text: { uk: "Ранок" } }];
    const g = pickGreeting({ now: friEvening, catalog: onlyMorning });
    expect(g).toBe("Ранок");
  });
});
