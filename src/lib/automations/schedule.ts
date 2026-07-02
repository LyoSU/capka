import { CronExpressionParser } from "cron-parser";
import { DateTime } from "luxon";

/** How an automation fires. `schedule` = recurring cron in the user's IANA
 *  timezone (cron-parser handles DST correctly — 09:00 local stays 09:00 local
 *  across transitions). `once` = a single wall-clock moment interpreted in that
 *  same IANA timezone (so "22:15" means 22:15 for the USER, not for the UTC
 *  server the worker runs on); after it passes the automation is done (the
 *  scheduler flips it to disabled, see runs). Discriminated by `kind` so Phase-2
 *  event triggers (webhook) fit the same jsonb column without a migration. */
export type AutomationTrigger =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "once"; at: string; timezone: string };

/** Next firing strictly after `after`, or null when there are no more
 *  (a `once` whose moment has passed). Throws on an invalid cron/timezone —
 *  callers validate at add time, so a throw here is a programming error. */
export function nextOccurrenceAfter(trigger: AutomationTrigger, after: Date): Date | null {
  if (trigger.kind === "once") {
    const at = onceInstant(trigger);
    return at.getTime() > after.getTime() ? at : null;
  }
  return CronExpressionParser.parse(trigger.cron, { currentDate: after, tz: trigger.timezone }).next().toDate();
}

/** The concrete UTC instant a `once` trigger fires at. `at` is a wall-clock ISO
 *  datetime WITHOUT offset (e.g. "2026-07-02T22:15:00"), read in the trigger's
 *  timezone — that's what makes "22:15" mean the user's 22:15. An `at` that DOES
 *  carry an offset/Z is honored as written (the zone then only affects display).
 *  Legacy rows written before `once` carried a timezone fall back to UTC, which
 *  reproduces their old (server-local == UTC) behavior rather than crashing.
 *  Throws on an unparseable value — validated at add time. */
export function onceInstant(trigger: { at: string; timezone?: string }): Date {
  const dt = DateTime.fromISO(trigger.at, { zone: trigger.timezone || "UTC" });
  if (!dt.isValid) throw new Error(`Invalid once_at "${trigger.at}" (${dt.invalidReason ?? "unparseable"}).`);
  return dt.toJSDate();
}

/** The next `n` occurrences after `after` — for the add-preview ("here are the
 *  next 3 run dates") and the frequency estimate. */
export function nextOccurrences(trigger: AutomationTrigger, n: number, after: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < n; i++) {
    const next = nextOccurrenceAfter(trigger, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
