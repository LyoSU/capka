/** Validate an IANA timezone id (e.g. "Europe/Kyiv") by asking Intl to use it —
 *  anything Intl rejects throws, so a try/catch is the canonical check. Shared by
 *  the auto-detect timezone route and the `manage` user.timezone control so the
 *  two can't drift on what counts as a valid zone. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
