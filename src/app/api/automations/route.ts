import { eq, inArray } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, tasks } from "@/lib/db/schema";
import { automationCollection } from "@/lib/manage/controls/automations";
import { audit } from "@/lib/governance/audit";

export const GET = apiHandler(async () => {
  // Automations spend the shared key unattended, so a pending/rejected account may
  // not even list them — requireActive, matching the MCP/skill mutation routes.
  const { userId } = await requireActive();
  const rows = await db.select().from(automations).where(eq(automations.userId, userId));
  // Resolve each last run's chat for an "open last run" link — one batched query
  // over the referenced task ids, not one round-trip per automation.
  const lastTaskIds = rows.map((a) => a.lastTaskId).filter((id): id is string => !!id);
  const taskChats = lastTaskIds.length
    ? await db.select({ id: tasks.id, chatId: tasks.chatId }).from(tasks).where(inArray(tasks.id, lastTaskIds))
    : [];
  const chatByTask = new Map(taskChats.map((t) => [t.id, t.chatId]));
  const out = rows.map((a) => ({
    id: a.id, title: a.title, prompt: a.prompt, trigger: a.trigger,
    enabled: a.enabled, nextRunAt: a.nextRunAt, lastRunAt: a.lastRunAt,
    consecutiveFailures: a.consecutiveFailures,
    lastChatId: a.lastTaskId ? chatByTask.get(a.lastTaskId) ?? null : null,
  }));
  return Response.json({ automations: out });
});

/**
 * Create one from the settings page.
 *
 * Goes through the manage collection's own schema, validateAdd and add rather
 * than repeating them: the platform switch, the minimum interval between runs
 * and the per-user cap are the rules for HAVING an automation, not rules of the
 * chat that happened to create one. A second implementation here would drift
 * from those the first time a limit changes.
 *
 * `model: null` (no ctx.model) on purpose — one created here has no originating
 * chat to inherit a model from, so its runs resolve the account default.
 */
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireActive();
  const body = await req.json().catch(() => null);
  const parsed = automationCollection.addSchema!.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  // addSchema is a ZodTypeAny, so its output widens to unknown; the collection
  // reads args as a loose record and re-narrows each field itself.
  const args = parsed.data as Record<string, unknown>;
  const ctx = { userId, isAdmin: role === "admin", projectId: null };
  try {
    await automationCollection.validateAdd?.(ctx, args);
    const { itemTitle } = await automationCollection.add!(ctx, args);
    // Unattended spend starts here, so it belongs in the trail under the same
    // action the chat-driven path records.
    await audit({ actorId: userId, action: "automation.add", targetType: "automation", targetKey: itemTitle });
    return Response.json({ ok: true });
  } catch (e) {
    // validateAdd/parseTriggerArgs throw sentences written for a person ("This
    // schedule runs more often than…"), so pass them through instead of
    // replacing them with a generic failure.
    return Response.json({ error: e instanceof Error ? e.message : "Could not create" }, { status: 400 });
  }
});
