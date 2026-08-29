import type { Greeting } from "@/lib/chat/greeting";

// The pool of new-chat greetings. The engine (`greeting.ts`) reads the moment
// and picks one that fits — this file is just the WHEN of each line and is meant
// to GROW. The line's actual words live in `chat.greetings.<id>` in the message
// catalogs, so adding one means adding an entry here plus a key in every locale
// (`__tests__/greeting.test.ts` fails when the two drift apart).
//
// How a line is chosen:
//   - Every condition you set must hold (time/weekdays/months/seasons/weekend).
//     Leave a dimension out and it matches any value of it.
//   - A line with `{name}` is only shown when the user's first name is known;
//     keep a healthy floor of name-less time-of-day lines so there's always
//     something to show.
//   - More specific lines (more conditions) are likelier to win *when their
//     moment comes*, so a Friday-evening line isn't drowned out by generics.
//
// weekday numbers: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat.
//
// Two constraints on the TEXTS, which is why they are not free translations:
//
// NAMES: `{name}` is substituted in the NOMINATIVE case (no vocative yet). In an
// inflected language that is only correct where the name is the grammatical
// SUBJECT ("is {name} already at it?"), never a vocative address ("Good morning,
// {name}!" would need the name declined). English carries no such constraint —
// address directly there. The locales are tone-equivalent, not literal.
//
// SELF-REFERENCE: keep the assistant genderless. In languages that inflect
// predicate adjectives for gender, avoid them about itself ("ready" picks a
// gender in Ukrainian) and prefer verbs ("I'll help", "I'm here").

export const GREETINGS: Greeting[] = [
  // ── Morning (05–11) ──────────────────────────────────────────────────────
  { id: "morning-1", time: ["morning"] },
  { id: "morning-2", time: ["morning"] },
  { id: "morning-3", time: ["morning"], weight: 0.7 },
  { id: "morning-name-1", time: ["morning"] },
  { id: "morning-name-2", time: ["morning"] },

  // ── Afternoon (12–16) ──────────────────────────────────────────────────────
  { id: "afternoon-1", time: ["afternoon"] },
  { id: "afternoon-2", time: ["afternoon"] },
  { id: "afternoon-3", time: ["afternoon"], weight: 0.7 },
  { id: "afternoon-name-1", time: ["afternoon"] },
  { id: "afternoon-name-2", time: ["afternoon"] },

  // ── Evening (17–21) ──────────────────────────────────────────────────────
  { id: "evening-1", time: ["evening"] },
  { id: "evening-2", time: ["evening"] },
  { id: "evening-3", time: ["evening"], weight: 0.7 },
  { id: "evening-name-1", time: ["evening"] },
  { id: "evening-name-2", time: ["evening"] },

  // ── Night (22–04) — the "still up?" zone ───────────────────────────────────
  { id: "night-1", time: ["night"] },
  { id: "night-2", time: ["night"] },
  { id: "night-3", time: ["night"], weight: 0.6 },
  { id: "night-name-1", time: ["night"] },

  // ── Monday ──────────────────────────────────────────────────────────────
  { id: "monday-1", weekdays: [1], time: ["morning", "afternoon"], weight: 1.3 },
  { id: "monday-2", weekdays: [1], time: ["morning"], weight: 1.1 },
  { id: "monday-name", weekdays: [1], time: ["morning", "afternoon"], weight: 1.1 },

  // ── Friday ────────────────────────────────────────────────────────────────
  { id: "friday-1", weekdays: [5], time: ["afternoon", "evening"], weight: 1.4 },
  { id: "friday-2", weekdays: [5], time: ["afternoon"], weight: 1.1 },
  { id: "friday-eve", weekdays: [5], time: ["evening"], weight: 1.4 },

  // ── Weekend ───────────────────────────────────────────────────────────────
  { id: "weekend-1", weekend: true, weight: 1.1 },
  { id: "weekend-2", weekend: true, time: ["afternoon", "evening"] },
  { id: "weekend-night", weekend: true, time: ["night"], weight: 1.4 },

  // ── Seasonal ──────────────────────────────────────────────────────────────
  { id: "winter-morning", seasons: ["winter"], time: ["morning"], weight: 1.1 },
  { id: "winter-evening", seasons: ["winter"], time: ["evening"], weight: 0.8 },
  { id: "spring", seasons: ["spring"], time: ["morning", "afternoon"], weight: 0.8 },
  { id: "summer", seasons: ["summer"], time: ["afternoon", "evening"], weight: 0.8 },
  { id: "autumn-evening", seasons: ["autumn"], time: ["evening"], weight: 0.9 },

  // ── Easter eggs (narrow combos — rare, but specificity makes them likely
  //    the moment their exact slot hits) ──────────────────────────────────────
  { id: "friday-night", weekdays: [5], time: ["night"], weight: 1.6 },
  { id: "sunday-evening", weekdays: [0], time: ["evening"], weight: 1.4 },
  { id: "winter-monday-morning", weekdays: [1], time: ["morning"], seasons: ["winter"], weight: 1.8 },
  { id: "summer-friday-eve", weekdays: [5], time: ["evening"], seasons: ["summer"], weight: 1.8 },
  { id: "deep-night-name", weekdays: [1, 2, 3, 4, 5], time: ["night"], weight: 1.5 },

  // ── Minimal / any-time floor (low weight, rare) ────────────────────────────
  { id: "minimal-1", weight: 0.4 },
  { id: "minimal-2", weight: 0.4 },
  { id: "minimal-3", weight: 0.4 },
];
