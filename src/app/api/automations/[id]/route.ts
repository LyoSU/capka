import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, automationWebhookDeliveries } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { parseTriggerArgs, assertMinInterval, mintWebhookToken } from "@/lib/manage/controls/automations";
import { nextOccurrenceAfter, type AutomationTrigger } from "@/lib/automations/schedule";
import { audit } from "@/lib/governance/audit";

// Every field optional, but a body of nothing is a mistake worth naming rather
// than a silent no-op that reports success. `enabled` stays a strict boolean: a
// lenient Boolean("false") would turn a pause into a re-enable.
const patchBody = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().min(1).max(80).optional(),
    prompt: z.string().min(1).optional(),
    // The schedule arrives in the same FLAT shape the manage tool uses, so both
    // paths reach the one validator instead of growing a second dialect of it.
    cron: z.string().optional(),
    once_at: z.string().optional(),
    webhook: z.boolean().optional(),
    timezone: z.string().optional(),
    // null is a real value here ("no ceiling"), which is why this is nullable
    // rather than only optional — `undefined` means "leave it alone".
    max_runs_per_day: z.number().int().min(1).max(1000).nullable().optional(),
    thread_mode: z.enum(["fresh", "single"]).optional(),
    // The condition sentence. Nullable for the same reason as the ceiling —
    // clearing it has to be able to REMOVE the gate — and trimmed to null when
    // the field is emptied, so a row never carries whitespace that would read as
    // a condition and pay for a model call to judge it.
    run_when: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to update." });

export const PATCH = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  // Editing changes what runs unattended on the shared key — active accounts only.
  const { userId } = await requireActive();
  const { id } = await params;
  const parsed = patchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const { enabled, title, prompt, cron, once_at, webhook, timezone, max_runs_per_day, thread_mode, run_when } = parsed.data;
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.userId, userId)));
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });

  // A new schedule is validated (and rejected) BEFORE anything is written: a
  // half-applied edit that kept the old cron under the new title would fire at a
  // time the user believes they have changed.
  let trigger: AutomationTrigger | undefined;
  if (cron !== undefined || once_at !== undefined || webhook !== undefined) {
    try {
      trigger = parseTriggerArgs({ cron, once_at, webhook, timezone });
      assertMinInterval(trigger, Number((await getSetting("automations_min_interval_minutes")) ?? "60"));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Invalid schedule" }, { status: 400 });
    }
  }

  // The token follows the trigger kind, both ways. Becoming a webhook mints one
  // (a webhook row without a URL is a dead endpoint); ceasing to be one clears it,
  // so switching back and forth cannot resurrect an address the user believed was
  // gone. Either move invalidates the old address, so the delivery keys recorded
  // against it go too — leaving them could let a stale key from the previous
  // caller swallow the new caller's first delivery inside the 24h window.
  const becomesWebhook = trigger?.kind === "webhook";
  const wasWebhook = (row.trigger as AutomationTrigger).kind === "webhook";
  const webhookToken = trigger === undefined || becomesWebhook === wasWebhook
    ? undefined
    : becomesWebhook ? mintWebhookToken() : null;
  if (webhookToken !== undefined) {
    await db.delete(automationWebhookDeliveries).where(eq(automationWebhookDeliveries.automationId, id));
  }

  // The horizon is recomputed from now whenever the schedule moves or the
  // automation is switched back on — never backfilled, so a paused week doesn't
  // fire seven times the moment it resumes.
  const effectiveTrigger = trigger ?? (row.trigger as AutomationTrigger);
  const resumes = enabled === true;
  await db
    .update(automations)
    .set({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(trigger ? { trigger } : {}),
      ...(webhookToken !== undefined ? { webhookToken } : {}),
      ...(max_runs_per_day !== undefined ? { maxRunsPerDay: max_runs_per_day } : {}),
      ...(run_when !== undefined ? { runWhen: run_when?.trim() || null } : {}),
      ...(thread_mode !== undefined ? { threadMode: thread_mode } : {}),
      // Leaving `single` mode does NOT delete the thread chat: it is a real
      // conversation the user can still read. The id is dropped so a later switch
      // back opens a fresh thread rather than silently reviving an old one.
      ...(thread_mode === "fresh" ? { threadChatId: null } : {}),
      // nextRunAt is recomputed from the EFFECTIVE trigger, which is null for a
      // webhook — that null is what keeps the row out of the scheduler's claim.
      ...(trigger || resumes ? { nextRunAt: nextOccurrenceAfter(effectiveTrigger, new Date()) } : {}),
      // Re-enabling means "try again"; so does moving the schedule after a
      // failing run. Both clear the streak that would auto-pause it again.
      ...(trigger || resumes ? { consecutiveFailures: 0 } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, id));

  // Toggling and editing are different acts in the trail: one resumes spending,
  // the other changes what gets spent on.
  const onlyToggling = enabled !== undefined && title === undefined && prompt === undefined && !trigger
    && max_runs_per_day === undefined && thread_mode === undefined && run_when === undefined;
  await audit({
    actorId: userId,
    action: onlyToggling ? (enabled ? "automation.enable" : "automation.disable") : "automation.update",
    targetType: "automation",
    targetKey: title ?? row.title,
  });
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireActive();
  const { id } = await params;
  const res = await db.delete(automations).where(and(eq(automations.id, id), eq(automations.userId, userId))).returning({ id: automations.id, title: automations.title });
  if (!res.length) return Response.json({ error: "Not found" }, { status: 404 });
  await audit({ actorId: userId, action: "automation.remove", targetType: "automation", targetKey: res[0].title });
  return Response.json({ ok: true });
});
