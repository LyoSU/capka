import { CronExpressionParser } from "cron-parser";

/** How an automation fires. `schedule` = recurring cron in the user's IANA
 *  timezone (cron-parser handles DST correctly — 09:00 local stays 09:00 local
 *  across transitions). `once` = a single ISO moment; after it passes the
 *  automation is done (the scheduler flips it to disabled, see runs).
 *  Discriminated by `kind` so Phase-2 event triggers (webhook) fit the same
 *  jsonb column without a migration. */
export type AutomationTrigger =
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "once"; at: string };

/** Next firing strictly after `after`, or null when there are no more
 *  (a `once` whose moment has passed). Throws on an invalid cron/timezone —
 *  callers validate at add time, so a throw here is a programming error. */
export function nextOccurrenceAfter(trigger: AutomationTrigger, after: Date): Date | null {
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  return CronExpressionParser.parse(trigger.cron, { currentDate: after, tz: trigger.timezone }).next().toDate();
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
