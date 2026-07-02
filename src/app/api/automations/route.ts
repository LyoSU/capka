import { eq } from "drizzle-orm";
import { apiHandler, requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { automations, tasks } from "@/lib/db/schema";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  const rows = await db.select().from(automations).where(eq(automations.userId, userId));
  // Resolve the last run's chat for a "open last run" link.
  const out = [];
  for (const a of rows) {
    let lastChatId: string | null = null;
    if (a.lastTaskId) {
      const [t] = await db.select({ chatId: tasks.chatId }).from(tasks).where(eq(tasks.id, a.lastTaskId));
      lastChatId = t?.chatId ?? null;
    }
    out.push({
      id: a.id, title: a.title, prompt: a.prompt, trigger: a.trigger,
      enabled: a.enabled, nextRunAt: a.nextRunAt, lastRunAt: a.lastRunAt,
      consecutiveFailures: a.consecutiveFailures, lastChatId,
    });
  }
  return Response.json({ automations: out });
});
