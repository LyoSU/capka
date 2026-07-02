import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { getSetting } from "@/lib/settings";
import { isValidTimezone } from "@/lib/timezone";
import { nextOccurrenceAfter, nextOccurrences, type AutomationTrigger } from "@/lib/automations/schedule";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext } from "../types";

/** Model-facing args are FLAT (weak models fumble nested unions): recurring =
 *  cron+timezone, one-off = once_at. Exactly one form must be present. */
export function parseTriggerArgs(args: Record<string, unknown>): AutomationTrigger {
  const cron = typeof args.cron === "string" ? args.cron : undefined;
  const onceAt = typeof args.once_at === "string" ? args.once_at : undefined;
  if (cron && onceAt) throw new Error("Give either a recurring schedule (cron) or a one-off moment (once_at), not both.");
  if (cron) {
    const timezone = typeof args.timezone === "string" ? args.timezone : "";
    if (!isValidTimezone(timezone)) throw new Error("A valid IANA timezone is required with cron (e.g. Europe/Kyiv). Use the user's timezone setting.");
    const trigger: AutomationTrigger = { kind: "schedule", cron, timezone };
    nextOccurrenceAfter(trigger, new Date()); // throws on an invalid expression
    return trigger;
  }
  if (onceAt) {
    if (Number.isNaN(Date.parse(onceAt))) throw new Error("once_at must be an ISO datetime.");
    if (!nextOccurrenceAfter({ kind: "once", at: onceAt }, new Date())) throw new Error("once_at is already in the past.");
    return { kind: "once", at: onceAt };
  }
  throw new Error("A schedule is required: cron or once_at.");
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
    timeZone: trigger.kind === "schedule" ? trigger.timezone : undefined,
  });
  const nextDates = nextOccurrences(trigger, 3, after).map((d) => fmt.format(d));
  const inMonth = trigger.kind === "once" ? 1
    : nextOccurrences(trigger, 200, after).filter((d) => d.getTime() - after.getTime() < 30 * 86_400_000).length;
  return { nextDates, perMonth: inMonth };
}

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
    "Scheduled agent runs: the platform runs a saved instruction on a schedule (or once at a set time) with no tab open. Each run opens a new chat; results also go to Telegram when linked. Offer this when the user describes a recurring intent.",
  usage:
    "add args: {title, prompt, cron, timezone} for a recurring schedule, or {title, prompt, once_at} for a one-off. " +
    "title and prompt are ALWAYS required — title is a short label the user sees in the automations list; prompt is the FULL instruction " +
    "the agent will run each time, written as if starting a fresh conversation. " +
    "cron is a 5-field expression evaluated in `timezone` (IANA, e.g. Europe/Kyiv — use the user's timezone); once_at is an ISO datetime.",
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
  }).refine((v) => Boolean(v.cron) !== Boolean(v.once_at), {
    message: 'Provide EITHER "cron" (with "timezone") for a recurring schedule OR "once_at" (an ISO datetime) for a one-off, not both.',
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
    return {
      title: loc(t, "automation.addTitle", "Add automation"),
      after: String(args.title),
      details: trigger.kind === "once"
        ? loc(t, "automation.previewOnce", `Runs once: ${nextDates[0]}.`, { date: nextDates[0] })
        : loc(t, "automation.previewRecurring",
            `Next runs: ${nextDates.join(" · ")} — about ${perMonth} runs per month, each spending tokens like a normal turn.`,
            { dates: nextDates.join(" · "), count: perMonth }),
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
      trigger,
      nextRunAt: nextOccurrenceAfter(trigger, new Date()),
    });
    return { itemTitle: String(args.title) };
  },
  list: async (ctx) => {
    const t = manageT(ctx.locale);
    const rows = await db.select().from(automations).where(eq(automations.userId, ctx.userId));
    return rows.map((a) => {
      const { nextDates } = humanizeSchedule(a.trigger as AutomationTrigger, ctx.locale);
      return {
        id: a.id,
        title: a.title,
        subtitle: a.enabled && nextDates[0] ? loc(t, "automation.nextSubtitle", `next: ${nextDates[0]}`, { date: nextDates[0] }) : undefined,
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
      // failure streak — the user explicitly said "try again".
      ...(enabled ? { nextRunAt: nextOccurrenceAfter(row.trigger as AutomationTrigger, new Date()), consecutiveFailures: 0 } : {}),
      updatedAt: new Date(),
    }).where(eq(automations.id, itemId));
    return { itemTitle: row.title };
  },
  debug: async (ctx, itemId) => {
    const row = await mustOwn(ctx, itemId);
    const t = manageT(ctx.locale);
    const { nextDates } = humanizeSchedule(row.trigger as AutomationTrigger, ctx.locale);
    const stateKey = !row.enabled ? "disabled" : row.consecutiveFailures > 0 ? "failing" : "ok";
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
        nextDates[0] && row.enabled ? loc(t, "automation.nextRun", `Next run: ${nextDates[0]}`, { date: nextDates[0] }) : undefined,
        row.lastRunAt
          ? loc(t, "automation.lastRun", `Last run: ${row.lastRunAt.toISOString()}`, { date: row.lastRunAt.toISOString() })
          : loc(t, "automation.neverRan", "Never ran yet"),
        cost?.avg
          ? loc(t, "automation.avgCost", `Average cost per run: ≈$${Number(cost.avg).toFixed(4)} over ${cost.runs} runs`,
              { cost: Number(cost.avg).toFixed(4), runs: cost.runs })
          : undefined,
        row.consecutiveFailures ? loc(t, "automation.failures", `Consecutive failures: ${row.consecutiveFailures}`, { n: row.consecutiveFailures }) : undefined,
      ].filter(Boolean).join(" · "),
      hint: stateKey === "disabled" && row.consecutiveFailures >= 3
        ? loc(t, "automation.autoPausedHint", "Auto-paused after repeated failures. Check the last run's chat, then enable it again.")
        : undefined,
    };
  },
};
