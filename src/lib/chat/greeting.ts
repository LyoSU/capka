// The new-chat greeting ("How can I help?") rotates through a catalog of
// lines that vary by the moment — time of day, weekday, season — and weave in
// the user's first name. Claude does the same: a fresh chat feels addressed to
// *you, now*, not stamped from a template.
//
// Split of concerns:
//   - this file = the ENGINE (pure, testable): read the moment, filter the
//     catalog to what fits, pick one, fill the name.
//   - `greetings.catalog.ts` = the WHEN of each line; its words live under
//     `chat.greetings.<id>` in the message catalogs. Those two are the ones to
//     grow; the engine never needs touching to add a greeting.
//
// Selection runs CLIENT-SIDE only: the server has no idea what time it is in
// the user's timezone, and the line is random, so computing it during SSR would
// guarantee a hydration mismatch. The caller renders the static fallback until
// mount, then swaps in the live pick.

import { GREETINGS } from "@/lib/chat/greetings.catalog";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
export type Season = "winter" | "spring" | "summer" | "autumn";

/** The decoded "now" a greeting is matched against. All derived from one Date so
 *  the engine stays a pure function of its inputs (easy to test). */
export interface Moment {
  /** Local hour bucket. night = 22:00–04:59 (the "still up?" zone). */
  time: TimeOfDay;
  /** 0 = Sunday … 6 = Saturday (JS getDay convention). */
  weekday: number;
  /** 1–12. */
  month: number;
  season: Season;
  isWeekend: boolean;
}

/** One catalog line plus the conditions under which it may appear. Every
 *  condition is optional — an absent dimension means "matches any". `{name}` in
 *  a text is filled with the user's first name; a line that uses it is only
 *  eligible when a name is known (see `needsName`). */
export interface Greeting {
  /** Also the message key: the line's words are `chat.greetings.<id>`. */
  id: string;
  time?: TimeOfDay[];
  /** Specific weekdays (0–6) this line is for, e.g. [1] = Mondays. */
  weekdays?: number[];
  months?: number[];
  seasons?: Season[];
  /** true = weekends only, false = weekdays only, undefined = any day. */
  weekend?: boolean;
  /** Only offer this line when a name is available. Auto-detected from a
   *  `{name}` placeholder in the resolved text; set explicitly only to override. */
  needsName?: boolean;
  /** Relative likelihood within its specificity tier (default 1). */
  weight?: number;
}

/** Map a calendar month (1–12) to its meteorological season (Ukraine / N. hemisphere). */
function seasonOf(month: number): Season {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

/** Map a local hour (0–23) to its time-of-day bucket. */
function timeOf(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** Decode a Date into the moment a greeting is matched against. */
export function getMoment(now: Date): Moment {
  const weekday = now.getDay();
  const month = now.getMonth() + 1;
  return {
    time: timeOf(now.getHours()),
    weekday,
    month,
    season: seasonOf(month),
    isWeekend: weekday === 0 || weekday === 6,
  };
}

/** Pull a clean first name out of whatever the auth profile holds (could be a
 *  full name, could be empty/email-ish). Returns null when there's nothing
 *  usable, so name-only lines are skipped rather than rendering "Hi !". */
export function firstName(name?: string | null): string | null {
  const raw = (name ?? "").trim();
  if (!raw || raw.includes("@")) return null; // empty or an email, not a name
  const first = raw.split(/\s+/)[0];
  // Guard against junk tokens; a real given name is short and not all-symbols.
  if (first.length === 0 || first.length > 32 || !/\p{L}/u.test(first)) return null;
  return first;
}

/** A line matches the moment when every condition it *does* set is satisfied. */
function matches(g: Greeting, m: Moment): boolean {
  if (g.time && !g.time.includes(m.time)) return false;
  if (g.weekdays && !g.weekdays.includes(m.weekday)) return false;
  if (g.months && !g.months.includes(m.month)) return false;
  if (g.seasons && !g.seasons.includes(m.season)) return false;
  if (g.weekend !== undefined && g.weekend !== m.isWeekend) return false;
  return true;
}

/** How many dimensions a line pins down. More specific lines (a Friday-evening
 *  line vs. a generic one) get a likelihood boost so the rare, well-targeted
 *  greetings actually surface when their moment comes. */
function specificity(g: Greeting): number {
  return (
    (g.time ? 1 : 0) +
    (g.weekdays ? 1 : 0) +
    (g.months ? 1 : 0) +
    (g.seasons ? 1 : 0) +
    (g.weekend !== undefined ? 1 : 0)
  );
}

function needsName(g: Greeting, text: string): boolean {
  return g.needsName ?? text.includes("{name}");
}

export interface PickOptions {
  /** Resolves a greeting id against the `chat.greetings` namespace. The caller
   *  owns the locale, so the engine never needs to know it. */
  t: (id: string) => string;
  now?: Date;
  name?: string | null;
  /** Override the catalog (tests). Defaults to the shipped one. */
  catalog?: Greeting[];
  /** Injectable RNG in [0,1) for deterministic tests. */
  random?: () => number;
}

/**
 * Pick the greeting to show right now. Filters the catalog to lines that fit
 * the moment (and that have the name they need), then draws one weighted toward
 * the more specific. Returns the resolved, name-filled text — never null,
 * because the catalog always carries name-less time-of-day lines as a floor.
 */
export function pickGreeting(opts: PickOptions): string {
  const now = opts.now ?? new Date();
  const catalog = opts.catalog ?? GREETINGS;
  const rng = opts.random ?? Math.random;
  const name = firstName(opts.name);
  const moment = getMoment(now);

  // Resolved once per line: the name filter and the render both need the text,
  // and a translator call per line per pass is the kind of thing that quietly
  // doubles as the catalog grows.
  const lines = catalog.map((g) => ({ g, text: opts.t(g.id) }));
  const eligible = lines.filter(
    ({ g, text }) => matches(g, moment) && (needsName(g, text) ? !!name : true),
  );

  // Substitute the name, or trim a trailing-comma form like "Good morning,
  // {name}!" down cleanly when it is absent.
  const render = (text: string): string =>
    name ? text.replace("{name}", name) : text.replace(/,?\s*\{name\}/, "");

  // Should not happen with a healthy catalog, which carries name-less any-time
  // lines as a floor; fail soft to the first line rather than to an empty header.
  if (eligible.length === 0) return lines[0] ? render(lines[0].text) : "";

  const weights = eligible.map(({ g }) => (g.weight ?? 1) * (1 + specificity(g)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r < 0) return render(eligible[i].text);
  }
  return render(eligible[eligible.length - 1].text);
}
