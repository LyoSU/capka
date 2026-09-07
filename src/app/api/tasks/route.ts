import { eq, and, sql } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";

/**
 * GET /api/tasks?chatId=X — the chat's LIVE turn, plus whatever is waiting behind it.
 *
 * "The latest row by created_at" was the wrong answer to "what is this chat doing":
 * a chat's turns are serialized, so a follow-up sent while a reply streams (Telegram,
 * a second tab, an automation) sits QUEUED and is newer than the turn actually
 * running. Every caller asks this endpoint for the running turn — stop() cancels it,
 * steer() folds text into it — so the newer queued row made Stop flag a turn that had
 * not started (the reply kept streaming) and made a steer look impossible. Order the
 * running row first; `created_at desc` still decides among the rest.
 *
 * `queued` is the chat's pending follow-up (at most one — `uq_tasks_one_queued_per_chat`),
 * carried alongside so a client can SAY something is waiting instead of discovering it
 * when the next reply appears. Its `platform` is that of the newest user message the
 * queued turn will answer, which is the only thing that tells the user where it came from.
 */
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  // Project only what the client needs — the payload column holds the full chat
  // history (jsonb) and is never used here, so don't ship it on every poll.
  const [task] = await db
    .select({ id: tasks.id, status: tasks.status, error: tasks.error })
    .from(tasks)
    .where(and(eq(tasks.chatId, chatId), eq(tasks.userId, userId)))
    .orderBy(sql`(${tasks.status} = 'running') desc, ${tasks.createdAt} desc`)
    .limit(1);

  if (!task) return Response.json(null);

  const [queued] = await db
    .select({
      id: tasks.id,
      createdAt: tasks.createdAt,
      // The message that made this turn exist, not the turn's own row: a task
      // carries no platform, and the answer the user needs is "where did this
      // come from". The queued turn answers from the chat's newest user message
      // (the runner re-reads the live leaf), so that row is the right witness.
      platform: sql<string | null>`(SELECT m.platform FROM messages m
         WHERE m.chat_id = ${chatId} AND m.role = 'user'
         ORDER BY m.created_at DESC LIMIT 1)`,
    })
    .from(tasks)
    .where(and(eq(tasks.chatId, chatId), eq(tasks.userId, userId), eq(tasks.status, "queued")))
    .limit(1);

  return Response.json({
    ...task,
    queued: queued ? { ...queued, platform: queued.platform ?? "web" } : null,
  });
});
