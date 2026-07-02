import { nanoid } from "nanoid";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations, chats, messages, telegramLinks, users, tasks } from "@/lib/db/schema";
import { enqueueTask } from "@/lib/tasks/queue";
import { publishTaskEvent } from "@/lib/tasks/events";
import { toUIMessages } from "@/lib/chat/presenter";
import { loadActivePath } from "@/lib/chat/tree";
import type { TaskPayload } from "@/lib/tasks/runner";
import { log } from "@/lib/log";

export type AutomationRow = typeof automations.$inferSelect;

/** After this many failed runs in a row the automation disables itself and
 *  tells the user — a silent failure loop burning budget is the #1 complaint
 *  about every competitor's scheduled tasks. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Materialize one firing: a NEW ordinary chat holding one user message (the
 * automation's prompt), then a normal enqueued task — exactly how a Telegram
 * message becomes a turn. Returns { fired: false } when the previous run is
 * still live (overlap guard): the occurrence is skipped, not queued behind.
 */
export async function fireAutomation(a: AutomationRow): Promise<{ fired: boolean }> {
  if (a.lastTaskId) {
    const [prev] = await db.select({ status: tasks.status, chatId: tasks.chatId }).from(tasks).where(eq(tasks.id, a.lastTaskId));
    if (prev && (prev.status === "queued" || prev.status === "running")) {
      log.info("automation skipped: previous run still live", { automationId: a.id, lastTaskId: a.lastTaskId });
      return { fired: false };
    }
    // A finished task can still be BLOCKED: its reply suspended for the user's
    // approval/answer (task row "completed", message metadata awaiting_*). Firing
    // again would pile up parallel questions the user never asked for, so skip
    // until the last run is unblocked — the resume flips the message status away
    // from awaiting_* the moment the user responds, so this clears itself.
    if (prev && prev.status === "completed") {
      const [blocked] = await db.select({ id: messages.id }).from(messages)
        .where(and(
          eq(messages.chatId, prev.chatId),
          sql`${messages.metadata}->>'status' IN ('awaiting_answer', 'awaiting_approval')`,
        ))
        .limit(1);
      if (blocked) {
        log.info("automation skipped: previous run awaiting user input", { automationId: a.id, lastTaskId: a.lastTaskId });
        return { fired: false };
      }
    }
  }

  const [user] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, a.userId));
  const locale = user?.locale ?? "en";
  const chatId = nanoid();
  const runDate = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-US", { day: "numeric", month: "short" }).format(new Date());
  await db.insert(chats).values({
    id: chatId,
    userId: a.userId,
    projectId: a.projectId,
    title: `${a.title} — ${runDate}`,
    model: a.model,
    source: "web", // fully interactive in the web UI — the user can follow up
  });

  // Everything past this point can fail independently (no shared transaction —
  // enqueueTask issues its own raw-SQL round-trip). A failure here would otherwise
  // strand a chat with an unanswered user message and silently drop the occurrence
  // (the scheduler already advanced next_run_at before calling us), so clean up
  // the orphan chat on any failure — messages cascade-delete with it.
  try {
    const msgId = nanoid();
    await db.insert(messages).values({
      id: msgId,
      chatId,
      parentId: null,
      role: "user",
      content: a.prompt,
      platform: "automation",
    });
    await db.update(chats).set({ activeLeafId: msgId, updatedAt: new Date() }).where(eq(chats.id, chatId));
    await publishTaskEvent(a.userId, { type: "new_message", chatId });

    // Deliver to Telegram when linked — the run's full result lands in the
    // messenger via the existing TelegramSink, no new delivery code.
    const [link] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, a.userId));
    const path = await loadActivePath(chatId, msgId);
    const payload: TaskPayload = {
      requestModel: a.model ?? undefined,
      projectId: a.projectId ?? undefined,
      uiMessages: toUIMessages(path.map((p) => p.node)),
      automationId: a.id,
      ...(link ? { origin: { platform: "telegram" as const, telegramChatId: link.telegramUserId, locale } } : {}),
    };
    const taskId = nanoid();
    await enqueueTask({ id: taskId, chatId, userId: a.userId, payload });
    await db.update(automations)
      .set({ lastTaskId: taskId, lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(automations.id, a.id));
    return { fired: true };
  } catch (e) {
    await db.delete(chats).where(eq(chats.id, chatId)).catch(() => {});
    throw e;
  }
}

/**
 * Called by the runner after finalizeTask. Success resets the failure streak;
 * the third consecutive failure disables the automation and tells the user in
 * Telegram (the failed turns themselves are already visible in their chats).
 */
export async function recordAutomationOutcome(automationId: string, status: string): Promise<void> {
  // A suspended run (awaiting approval/answer) is neither success nor failure: it
  // didn't finish its work, so the streak must NOT reset — but it also isn't a
  // failure to count toward auto-disable. Leave the streak untouched.
  if (status === "suspended") return;
  if (status === "completed") {
    await db.update(automations)
      .set({ consecutiveFailures: 0, updatedAt: new Date() })
      .where(eq(automations.id, automationId));
    return;
  }
  if (status !== "failed") return; // cancelled etc. — not a failure streak
  const [row] = await db.update(automations)
    .set({ consecutiveFailures: sql`${automations.consecutiveFailures} + 1`, updatedAt: new Date() })
    .where(eq(automations.id, automationId))
    .returning();
  if (!row || row.consecutiveFailures < MAX_CONSECUTIVE_FAILURES || !row.enabled) return;
  await db.update(automations).set({ enabled: false, updatedAt: new Date() }).where(eq(automations.id, automationId));
  const [link] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, row.userId));
  if (link) {
    try {
      const { getBot } = await import("@/lib/telegram/bot");
      const bot = await getBot();
      const [user] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, row.userId));
      const text = user?.locale === "uk"
        ? `Я призупинила автоматизацію «${row.title}»: три запуски поспіль не вдалися. Перевірте останній запуск і ввімкніть її знову, коли будете готові.`
        : `I paused the automation "${row.title}": three runs in a row failed. Check the last run and re-enable it when ready.`;
      await bot?.api.sendMessage(link.telegramUserId, text);
    } catch (e) {
      log.warn("automation auto-disable notify failed", { automationId, err: String(e) });
    }
  }
}
