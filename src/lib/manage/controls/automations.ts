import { z } from "zod";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { getSetting } from "@/lib/settings";
import { isValidTimezone } from "@/lib/timezone";
import { localDayOf, nextOccurrenceAfter, nextOccurrences, type AutomationTrigger } from "@/lib/automations/schedule";
import type { AutomationDisabledReason, AutomationSkip } from "@/lib/automations/runs";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext } from "../types";

/** Model-facing args are FLAT (weak models fumble nested unions): recurring =
 *  cron+timezone, one-off = once_at, event-driven = webhook:true. Exactly one
 *  form must be present, and all three require the timezone — a webhook has no
 *  clock, but it still needs a day boundary for `max_runs_per_day`. */
export function parseTriggerArgs(args: Record<string, unknown>): AutomationTrigger {
  const cron = typeof args.cron === "string" ? args.cron : undefined;
  const onceAt = typeof args.once_at === "string" ? args.once_at : undefined;
  const webhook = args.webhook === true;
  if ([cron, onceAt, webhook || undefined].filter(Boolean).length > 1) {
    throw new Error("Give exactly one trigger: a recurring schedule (cron), a one-off moment (once_at), or webhook: true.");
  }
  if (webhook) {
    const timezone = typeof args.timezone === "string" ? args.timezone : "";
    if (!isValidTimezone(timezone)) throw new Error("A valid IANA timezone is required with webhook (e.g. Europe/Kyiv). Use the user's timezone setting — it defines the day a daily run limit counts against.");
    return { kind: "webhook", timezone };
  }
  if (cron) {
    const timezone = typeof args.timezone === "string" ? args.timezone : "";
    if (!isValidTimezone(timezone)) throw new Error("A valid IANA timezone is required with cron (e.g. Europe/Kyiv). Use the user's timezone setting.");
    const trigger: AutomationTrigger = { kind: "schedule", cron, timezone };
    nextOccurrenceAfter(trigger, new Date()); // throws on an invalid expression
    return trigger;
  }
  if (onceAt) {
    // A bare "2026-07-02T22:15:00" is a WALL-CLOCK time — it only means anything
    // once we know whose clock. Require the timezone (same as cron) so "22:15"
    // fires at the user's 22:15, not the UTC server's. isValidTimezone + a build
    // of the trigger (which throws on an unparseable datetime) validate both.
    const timezone = typeof args.timezone === "string" ? args.timezone : "";
    if (!isValidTimezone(timezone)) throw new Error("A valid IANA timezone is required with once_at (e.g. Europe/Kyiv). Use the user's timezone setting.");
    const trigger: AutomationTrigger = { kind: "once", at: onceAt, timezone };
    if (!nextOccurrenceAfter(trigger, new Date())) throw new Error("once_at is already in the past.");
    return trigger;
  }
  throw new Error("A trigger is required: cron, once_at, or webhook: true.");
}

/** A webhook automation's credential. The URL IS the secret, so it is minted here
 *  (24 random bytes, url-safe) and NEVER shown to the model — `debug` only tells
 *  it where the person can read the URL. Also used by the rotate route. */
export function mintWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

export function assertMinInterval(trigger: AutomationTrigger, minMinutes: number): void {
  if (trigger.kind !== "schedule") return;
  const [a, b] = nextOccurrences(trigger, 2);
  if (a && b && b.getTime() - a.getTime() < minMinutes * 60_000) {
    throw new Error(`This schedule runs more often than the platform minimum of ${minMinutes} minutes between runs.`);
  }
}

/** Next dates + a runs-per-month estimate for the approval preview — the user
 *  confirms concrete DATES (not cron syntax), and sees the frequency they're
 *  about to pay for. */
export function humanizeSchedule(trigger: AutomationTrigger, locale: string | undefined, after = new Date()) {
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    // Both kinds carry a timezone now — format the instant in it so the preview
    // shows the wall time the user actually asked for (not the server's UTC).
    timeZone: trigger.timezone,
  });
  const nextDates = nextOccurrences(trigger, 3, after).map((d) => fmt.format(d));
  const inMonth = trigger.kind === "once" ? 1
    : nextOccurrences(trigger, 200, after).filter((d) => d.getTime() - after.getTime() < 30 * 86_400_000).length;
  return { nextDates, perMonth: inMonth };
}

/** Plain-language counterpart of the `disabled_reason` column — what the person
 *  who owns the automation needs to know, and what to do about it. English lives
 *  here as the source of truth; `messages/*.json` translations are additive. */
const DISABLED_REASON_HINT: Record<AutomationDisabledReason, string> = {
  owner_suspended: "Turned off because this account is no longer active. Ask your administrator, then switch it back on yourself — it does not resume by itself.",
  project_deleted: "Turned off because the project it belonged to was deleted. Switch it back on to run it outside that project.",
  budget_exhausted: "Turned off after repeatedly running out of spending allowance. Switch it back on once there is room in the budget.",
};

/** Plain-language counterpart of `last_skip.reason`. The question a quiet
 *  automation prompts is "why hasn't it run", and the three answers ask for
 *  completely different things back: wait, raise the ceiling, or fix the
 *  condition. English here is the source of truth and the fallback. */
const SKIP_REASON: Record<AutomationSkip["reason"], string> = {
  daily_limit: "the daily run limit was already reached",
  busy: "the previous run was still working",
  condition: "the run condition was not met",
};

async function mustOwn(ctx: ManageContext, itemId: string) {
  const [row] = await db.select().from(automations)
    .where(and(eq(automations.id, itemId), eq(automations.userId, ctx.userId)));
  if (!row) throw new Error("No such automation.");
  return row;
}

export const automationCollection: Collection = {
  id: "automations",
  title: "Automations",
  description:
    "Unattended agent runs: the platform runs a saved instruction with no tab open — on a schedule, once at a set time, or whenever something calls the automation's private webhook URL. Each run opens a new chat (or appends to one ongoing chat); results also go to Telegram when linked. Offer this when the user describes a recurring intent, or wants another system to be able to trigger a run.",
  usage:
    "add args: {title, prompt, cron, timezone} for a recurring schedule, {title, prompt, once_at, timezone} for a one-off, or " +
    "{title, prompt, webhook: true, timezone} for one fired by an HTTP call. " +
    "title and prompt are ALWAYS required — title is a short label the user sees in the automations list; prompt is the FULL instruction " +
    "the agent will run each time, written as if starting a fresh conversation. " +
    "timezone is ALWAYS required (IANA, e.g. Europe/Kyiv — use the user's timezone setting): cron is a 5-field expression evaluated in it, " +
    "once_at is a wall-clock ISO datetime like \"2026-07-02T22:15:00\" (NO trailing Z / offset) read in that timezone, so \"22:15\" means the user's 22:15, and " +
    "for a webhook it fixes the day a run limit counts against. " +
    "Optional max_runs_per_day caps firings per day (skipped runs are reported, never silent), and thread_mode picks where runs go: " +
    "\"fresh\" (default, a new chat per run) or \"single\" (one ongoing chat the runs are appended to, so the agent keeps the thread's history). " +
    "Optional run_when is ONE plain sentence describing when a firing is worth running (e.g. \"only when the event is a failed payment over 100 EUR\", " +
    "\"only on working days\"): before each run a quick model call checks it against the clock and the incoming event, and skips the firing when it does not hold. " +
    "Leave run_when out unless the user actually described a condition — it costs a small model call on every firing, and an unmet condition is reported as a skip. " +
    "A webhook automation's URL is a credential and is NOT returned here — tell the user it is shown in Settings → Automations.",
  requiredRole: "user",
  auditNoun: "automation",
  settingsPath: "/settings/automations",
  // Spends money unattended — approval survives autonomous mode, like MCP installs.
  alwaysConfirm: true,
  // Re-enabling a paused automation resumes unattended, budget-spending runs, so
  // the human confirms it (a prompt-injected agent must not silently un-pause).
  confirmEnable: true,
  enableImpact: "Resumes scheduled runs that spend tokens unattended.",
  addSchema: z.object({
    title: z.string().min(1).max(80),
    prompt: z.string().min(1, "The instruction to run is required."),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    once_at: z.string().optional(),
    webhook: z.boolean().optional(),
    max_runs_per_day: z.number().int().min(1).max(1000).optional(),
    thread_mode: z.enum(["fresh", "single"]).optional(),
    // A sentence, not an essay: the whole thing is re-sent to a small model on
    // every firing, and a condition nobody can read in one breath is one the
    // gate will judge inconsistently.
    run_when: z.string().trim().max(500, "A run condition must be at most 500 characters.").optional(),
  }).refine((v) => [v.cron, v.once_at, v.webhook || undefined].filter(Boolean).length === 1, {
    message: 'Provide EXACTLY ONE trigger: "cron" for a recurring schedule, "once_at" (a wall-clock ISO datetime) for a one-off, or "webhook": true for one fired by an HTTP call — and always a "timezone" (IANA) with whichever you pick.',
  }),
  canAdd: async () => ((await getSetting("automations_enabled")) ?? "true") === "true",
  validateAdd: async (ctx, args) => {
    if (((await getSetting("automations_enabled")) ?? "true") !== "true") {
      throw new Error("Automations are disabled on this platform.");
    }
    const trigger = parseTriggerArgs(args);
    assertMinInterval(trigger, Number((await getSetting("automations_min_interval_minutes")) ?? "60"));
    const cap = Number((await getSetting("automations_per_user")) ?? "10");
    const mine = await db.select({ id: automations.id }).from(automations)
      .where(and(eq(automations.userId, ctx.userId), eq(automations.enabled, true)));
    if (mine.length >= cap) throw new Error(`Active automations limit reached (${cap}). Disable or remove one first.`);
  },
  previewAdd: async (ctx, args) => {
    const trigger = parseTriggerArgs(args);
    const t = manageT(ctx.locale);
    const { nextDates, perMonth } = humanizeSchedule(trigger, ctx.locale);
    // The condition is part of what the person is approving — an automation that
    // will refuse most of its own firings is a different thing to agree to than
    // one that runs every time, so it goes in the preview, not only in the row.
    const condition = typeof args.run_when === "string" && args.run_when.trim()
      ? loc(t, "automation.condition", `Only runs when: ${args.run_when.trim()}`, { condition: args.run_when.trim() })
      : null;
    return {
      title: loc(t, "automation.addTitle", "Add automation"),
      after: String(args.title),
      details: [trigger.kind === "webhook"
        ? loc(t, "automation.previewWebhook",
            "Runs whenever something calls its private web address, which is shown in Settings → Automations. Each call spends tokens like a normal turn.")
        : trigger.kind === "once"
        ? loc(t, "automation.previewOnce", `Runs once: ${nextDates[0]}.`, { date: nextDates[0] })
        : loc(t, "automation.previewRecurring",
            `Next runs: ${nextDates.join(" · ")} — about ${perMonth} ${perMonth === 1 ? "run" : "runs"} per month, each spending tokens like a normal turn.`,
            { dates: nextDates.join(" · "), count: perMonth }),
        condition,
      ].filter(Boolean).join(" "),
      body: String(args.prompt),
    };
  },
  add: async (ctx, args) => {
    const trigger = parseTriggerArgs(args);
    await db.insert(automations).values({
      id: nanoid(),
      userId: ctx.userId,
      projectId: ctx.projectId,
      title: String(args.title),
      prompt: String(args.prompt),
      // Inherit the creating chat's model so runs use it, not the account default
      // (null → default resolution in the runner). See the `model` column comment.
      model: ctx.model ?? null,
      trigger,
      // Minted with the row, not lazily: the URL is what the automation IS for a
      // webhook trigger, so a row without one would be a dead endpoint.
      webhookToken: trigger.kind === "webhook" ? mintWebhookToken() : null,
      maxRunsPerDay: typeof args.max_runs_per_day === "number" ? args.max_runs_per_day : null,
      // Empty → null, never "": a blank string would read as a condition and buy
      // a model call on every firing to judge nothing.
      runWhen: typeof args.run_when === "string" && args.run_when.trim() ? args.run_when.trim() : null,
      threadMode: args.thread_mode === "single" ? "single" : "fresh",
      nextRunAt: nextOccurrenceAfter(trigger, new Date()),
    });
    return { itemTitle: String(args.title) };
  },
  list: async (ctx) => {
    const t = manageT(ctx.locale);
    const rows = await db.select().from(automations).where(eq(automations.userId, ctx.userId));
    return rows.map((a) => {
      const trigger = a.trigger as AutomationTrigger;
      const { nextDates } = humanizeSchedule(trigger, ctx.locale);
      return {
        id: a.id,
        title: a.title,
        // A webhook has no next time to show — saying so is what stops the agent
        // reading a blank subtitle as a broken or paused automation. A condition
        // is appended rather than replacing the timing: "next Monday, but only
        // if…" is what the row actually promises, and either half alone misleads.
        subtitle: [
          trigger.kind === "webhook"
            ? loc(t, "automation.webhookSubtitle", "runs on webhook")
            : a.enabled && nextDates[0] ? loc(t, "automation.nextSubtitle", `next: ${nextDates[0]}`, { date: nextDates[0] }) : null,
          a.runWhen ? loc(t, "automation.conditionSubtitle", `only when: ${a.runWhen}`, { condition: a.runWhen }) : null,
        ].filter(Boolean).join(" · ") || undefined,
        enabled: a.enabled,
        owned: true,
      };
    });
  },
  remove: async (ctx, itemId) => {
    const row = await mustOwn(ctx, itemId);
    await db.delete(automations).where(eq(automations.id, itemId));
    return { itemTitle: row.title };
  },
  setEnabled: async (ctx, itemId, enabled) => {
    const row = await mustOwn(ctx, itemId);
    await db.update(automations).set({
      enabled,
      // Re-enabling recomputes the horizon from now (no backfill) and clears the
      // failure streak — the user explicitly said "try again". It also clears the
      // platform's explanation for the stop: this is the acknowledgement it was
      // written for (nothing else re-enables an automation — the scheduler never
      // does, not even when the account is reactivated).
      ...(enabled
        ? { nextRunAt: nextOccurrenceAfter(row.trigger as AutomationTrigger, new Date()), consecutiveFailures: 0, disabledReason: null }
        : {}),
      updatedAt: new Date(),
    }).where(eq(automations.id, itemId));
    return { itemTitle: row.title };
  },
  debug: async (ctx, itemId) => {
    const row = await mustOwn(ctx, itemId);
    const t = manageT(ctx.locale);
    const trigger = row.trigger as AutomationTrigger;
    const { nextDates } = humanizeSchedule(trigger, ctx.locale);
    const stateKey = !row.enabled ? "disabled" : row.consecutiveFailures > 0 ? "failing" : "ok";
    const reasonHint = DISABLED_REASON_HINT[row.disabledReason as AutomationDisabledReason];
    // Real average cost per run (spec §4.6 — the honest counterpart of the
    // creation-time frequency forecast). pending=false only: holds are estimates.
    const { rows: [cost] } = await (await import("@/lib/db")).pool.query<{ avg: string | null; runs: string }>(
      `SELECT avg(u.cost_usd)::text AS avg, count(*)::text AS runs
         FROM usage u JOIN tasks t ON t.id = u.task_id
        WHERE t.payload->>'automationId' = $1 AND u.pending = false`,
      [itemId],
    );
    return {
      itemTitle: row.title,
      state: loc(t, `state.${stateKey}`, stateKey),
      detail: [
        // Never the token itself — the URL is the credential, and a model that
        // has read it can be talked into repeating it. Point at where the person
        // reads it instead.
        trigger.kind === "webhook"
          ? loc(t, "automation.webhookDetail", "Fired by an HTTP call to its private web address (shown to the user in Settings → Automations, never here).")
          : undefined,
        nextDates[0] && row.enabled ? loc(t, "automation.nextRun", `Next run: ${nextDates[0]}`, { date: nextDates[0] }) : undefined,
        row.threadMode === "single"
          ? loc(t, "automation.singleThread", "Every run is added to one ongoing chat.")
          : undefined,
        row.runWhen
          ? loc(t, "automation.condition", `Only runs when: ${row.runWhen}`, { condition: row.runWhen })
          : undefined,
        // The cap and — crucially — what it has already refused today. A skip
        // that only ever appeared in a log would look to the agent (and to the
        // user asking it) exactly like a scheduler that had stopped firing.
        // The tallies belong to the stamped `runs_day`, so a row whose day has
        // rolled over reads as zero — showing yesterday's five as "used today"
        // would be a wrong number presented as a fact.
        row.maxRunsPerDay
          ? (() => {
              const fresh = row.runsDay === localDayOf(trigger);
              const used = fresh ? row.runsToday : 0;
              const skipped = fresh ? row.skippedToday : 0;
              return loc(t, "automation.dailyLimit", `Daily limit: ${row.maxRunsPerDay} runs (used ${used}, skipped ${skipped} today)`,
                { max: row.maxRunsPerDay, used, skipped });
            })()
          : undefined,
        row.lastRunAt
          ? loc(t, "automation.lastRun", `Last run: ${row.lastRunAt.toISOString()}`, { date: row.lastRunAt.toISOString() })
          : loc(t, "automation.neverRan", "Never ran yet"),
        // The last skip WITH its reason. Deliberately not scoped to today: the
        // question "why is this quiet" is asked precisely when the answer is
        // older than today, and a tally that reads zero would then be the only
        // thing on the row — which looks like a scheduler that stopped firing.
        (() => {
          const skip = row.lastSkip as AutomationSkip | null;
          if (!skip) return undefined;
          const why = loc(t, `automation.skipReason.${skip.reason}`, SKIP_REASON[skip.reason]);
          const reason = skip.note ? `${why} (${skip.note})` : why;
          return loc(t, "automation.lastSkip", `Last skipped ${skip.at}: ${reason}`, { date: skip.at, reason });
        })(),
        cost?.avg
          ? loc(t, "automation.avgCost", `Average cost per run: ≈$${Number(cost.avg).toFixed(4)} over ${cost.runs} ${Number(cost.runs) === 1 ? "run" : "runs"}`,
              { cost: Number(cost.avg).toFixed(4), runs: Number(cost.runs) })
          : undefined,
        row.consecutiveFailures ? loc(t, "automation.failures", `Consecutive failures: ${row.consecutiveFailures}`, { n: row.consecutiveFailures }) : undefined,
      ].filter(Boolean).join(" · "),
      // Why it stopped, when the platform stopped it rather than the user. A
      // recorded reason wins over the failure-streak wording: the streak is how
      // budget_exhausted disables too, so inferring from it would tell someone
      // over their limit to go read a chat that never ran.
      hint: reasonHint
        ? loc(t, `automation.disabledReason.${row.disabledReason}`, reasonHint)
        : stateKey === "disabled" && row.consecutiveFailures >= 3
          ? loc(t, "automation.autoPausedHint", "Auto-paused after repeated failures. Check the last run's chat, then enable it again.")
          : undefined,
    };
  },
};
