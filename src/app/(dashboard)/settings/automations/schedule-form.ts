import type { AutomationTrigger } from "@/lib/automations/schedule";

/**
 * The schedule as a person describes it, and the two conversions between that
 * and what the database stores.
 *
 * Separate from the editor component because this is the part that can be
 * wrong in silence: a round-trip that misreads "0 9 * * 1" as daily would move
 * someone's Monday report to every morning, and nothing on screen would look
 * broken. Kept pure so it can be tested that way.
 */
/** `webhook` sits in the same list as the frequencies because to the person
 *  filling this in it answers the same question — "when does this run?" — and
 *  splitting it into a separate trigger-kind control asks them to learn a
 *  distinction the product does not need them to have. */
export type Freq = "daily" | "weekly" | "monthly" | "once" | "webhook";

export interface ScheduleForm {
  /** `custom` is the honest escape hatch: automations created in chat can carry
   *  any cron ("every second Tuesday"), and a four-option picker would have to
   *  either lie about such a schedule or silently flatten it. Unrecognized
   *  expressions stay untouched until the user picks a simple frequency. */
  freq: Freq | "custom";
  time: string;        // "HH:MM" for daily/weekly/monthly
  weekdays: string[];  // "0".."6", Sunday-based like cron; sorted, at least one for `weekly`
  dayOfMonth: string;  // "1".."28"
  at: string;          // datetime-local value for `once`
  cron: string;        // the original expression, when freq === "custom"
  timezone: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const numeric = (v: string | undefined) => !!v && /^\d+$/.test(v);

/** Read a stored trigger back into the form. Only the three shapes this editor
 *  can write are recognized; everything else stays `custom`. */
export function toForm(trigger: AutomationTrigger, browserTz: string): ScheduleForm {
  const base: ScheduleForm = {
    freq: "custom", time: "09:00", weekdays: ["1"], dayOfMonth: "1",
    at: "", cron: "", timezone: trigger.timezone || browserTz,
  };
  if (trigger.kind === "webhook") return { ...base, freq: "webhook" };
  if (trigger.kind === "once") {
    // Stored as wall-clock ISO; datetime-local wants it without the seconds.
    return { ...base, freq: "once", at: trigger.at.slice(0, 16) };
  }
  const [m, h, dom, mon, dow] = trigger.cron.trim().split(/\s+/);
  // Anything with a month field, a list, a step or a range is beyond this form.
  if (!numeric(m) || !numeric(h) || mon !== "*") return { ...base, cron: trigger.cron };
  const time = `${pad(Number(h))}:${pad(Number(m))}`;
  if (dom === "*" && dow === "*") return { ...base, freq: "daily", time };
  // A list of days ("1,3,5") is still "weekly" to the person reading it — the
  // pills show which days — so it is the one list shape this form understands.
  // Ranges and steps ("1-5", "*/2") stay custom: they would round-trip as a
  // different string, and the stored expression is the one to keep.
  if (dom === "*" && dow.split(",").every((d) => numeric(d) && Number(d) <= 6)) {
    const weekdays = [...new Set(dow.split(",").map(Number))].sort((a, b) => a - b).map(String);
    return { ...base, freq: "weekly", time, weekdays };
  }
  // Days 29-31 are left to the raw expression: a "monthly" picker that silently
  // skips February is worse than showing the cron it really is.
  if (numeric(dom) && dow === "*" && Number(dom) <= 28) return { ...base, freq: "monthly", time, dayOfMonth: dom };
  return { ...base, cron: trigger.cron };
}

/** The form back into the flat {cron|once_at, timezone} shape the API validates
 *  — the same dialect the manage tool speaks, so both reach one validator. */
export function toTriggerArgs(f: ScheduleForm): { cron?: string; once_at?: string; webhook?: boolean; timezone: string } {
  const [h, m] = f.time.split(":").map(Number);
  // A webhook still sends the timezone: it has no clock, but the daily run limit
  // needs a day boundary, and this form is the only place that knows the user's.
  if (f.freq === "webhook") return { webhook: true, timezone: f.timezone };
  if (f.freq === "once") return { once_at: `${f.at}:00`, timezone: f.timezone };
  if (f.freq === "weekly") return { cron: `${m} ${h} * * ${f.weekdays.join(",")}`, timezone: f.timezone };
  if (f.freq === "monthly") return { cron: `${m} ${h} ${f.dayOfMonth} * *`, timezone: f.timezone };
  return { cron: `${m} ${h} * * *`, timezone: f.timezone };
}
