// Small shared formatters for the users list + drawer, so the two render the
// same money / date / relative-time strings without duplicating the logic.

export function money(locale: string, n: number): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);
}

export function shortDate(locale: string, iso: string | null): string {
  return iso ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "";
}

const REL_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 days ago" / "just now" for a session-activity timestamp. Empty for null. */
export function relTime(locale: string, iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now(); // negative = in the past
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of REL_UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, "second");
}
