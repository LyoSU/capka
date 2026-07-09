import { eq, inArray } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, tasks } from "@/lib/db/schema";

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
