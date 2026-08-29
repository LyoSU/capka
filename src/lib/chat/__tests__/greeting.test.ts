import { describe, it, expect } from "vitest";

import en from "../../../../messages/en.json";
import uk from "../../../../messages/uk.json";
import { getMoment, firstName, pickGreeting, type Greeting } from "@/lib/chat/greeting";
import { GREETINGS } from "@/lib/chat/greetings.catalog";

// A tiny, fully-controlled catalog so selection is deterministic and doesn't
// depend on whatever the shipped one happens to contain. Texts are supplied by
// the stub translator below, the same way the real one gets them from next-intl.
const catalog: Greeting[] = [
  { id: "morning", time: ["morning"] },
  { id: "morning-name", time: ["morning"] },
  { id: "evening", time: ["evening"] },
  { id: "friday-eve", time: ["evening"], weekdays: [5] },
];

const TEXTS: Record<string, string> = {
  morning: "Morning",
  "morning-name": "Hi, {name}",
  evening: "Evening",
  "friday-eve": "Friday eve",
};
const t = (id: string) => TEXTS[id] ?? id;

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
    expect(firstName("Ada Lovelace")).toBe("Ada");
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
    expect(pickGreeting({ t, now: monMorning, catalog, random: () => 0 })).toBe("Morning");
  });

  it("excludes {name} lines when no name is known", () => {
    // Force the last eligible line; without a name, morning-name is filtered out
    // so the only morning line left is the plain one.
    expect(pickGreeting({ t, now: monMorning, catalog, random: () => 0.999 })).toBe("Morning");
  });

  it("substitutes the first name into a {name} line", () => {
    const g = pickGreeting({ t, now: monMorning, name: "Ada Lovelace", catalog, random: () => 0.999 });
    expect(g).toBe("Hi, Ada");
  });

  it("favours the more specific line when its moment comes", () => {
    // Friday evening: both "evening" and the Friday-evening line are eligible.
    // The specific one carries extra weight, so a midpoint draw lands on it.
    expect(pickGreeting({ t, now: friEvening, catalog, random: () => 0.99 })).toBe("Friday eve");
  });

  it("falls back to a line when nothing matches the moment", () => {
    const onlyMorning: Greeting[] = [{ id: "morning", time: ["morning"] }];
    expect(pickGreeting({ t, now: friEvening, catalog: onlyMorning })).toBe("Morning");
  });
});

describe("greetings catalog", () => {
  // The catalog carries only the WHEN of each line; its words live in the message
  // catalogs. Nothing types that link, so a renamed or forgotten key would show
  // the raw id as the greeting on a fresh chat — checked here instead.
  it("resolves every greeting id in both locales", () => {
    const broken: string[] = [];
    for (const g of GREETINGS) {
      for (const [name, catalog] of [["en", en], ["uk", uk]] as const) {
        const text = (catalog.chat.greetings as Record<string, string>)[g.id];
        if (typeof text !== "string" || text === "") broken.push(`${name}: ${g.id}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("keeps a name-less floor for every time of day, so a nameless user always has a line", () => {
    const nameless = (id: string, cat: Record<string, string>) => !cat[id].includes("{name}");
    const ukTexts = uk.chat.greetings as Record<string, string>;
    for (const time of ["morning", "afternoon", "evening", "night"] as const) {
      const floor = GREETINGS.filter(
        (g) => (!g.time || g.time.includes(time)) && !g.weekdays && !g.seasons && g.weekend === undefined
          && nameless(g.id, ukTexts),
      );
      expect(floor.length, `no name-less line for ${time}`).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids", () => {
    const ids = GREETINGS.map((g) => g.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
