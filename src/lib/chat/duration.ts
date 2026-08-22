import type { Translator } from "@/lib/i18n/translator";

/** Renders a whole number of seconds through the `chat.duration` messages.
 *  Localized rather than latin `s`/`m` because these numbers sit inside Ukrainian
 *  sentences ("Міркував 8 с") where a bare `8s` reads as untranslated UI. This is
 *  the shape `chat.details.durationSec/durationMin` has always used for the (i)
 *  popover — the live timer and the group header were the two stragglers. */
function render(sec: number, t: Translator): string {
  if (sec < 60) return t("sec", { s: sec });
  // Padded: this is the one string that ticks under the reader's eye, and an
  // unpadded "1 хв 5 с" → "1 хв 10 с" jogs the row a character wider every
  // tenth second. `tabular-nums` fixes digit WIDTH, not digit COUNT.
  return t("minSec", { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, "0") });
}

/** A finished span, for the "Міркував …" / "Працював …" group header. Rounds:
 *  the measurement is over, so the nearest second is the truest single number. */
export function formatShortDuration(ms: number, t: Translator): string {
  return render(Math.max(0, Math.round(ms / 1000)), t);
}

/** The live stopwatch on the running-turn status row. Floors instead of
 *  rounding — a clock that shows a second which has not elapsed yet is wrong in
 *  the one direction users notice — and returns "" for the first five seconds:
 *  putting a number on a fast operation measures it for the user and thereby
 *  makes it feel slow. It appears only once not knowing is worse than knowing. */
export function formatLiveElapsed(ms: number, t: Translator): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  return sec < 5 ? "" : render(sec, t);
}
