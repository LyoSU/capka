import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { requestCancel, cancelQueuedTurn } from "@/lib/tasks/queue";

/**
 * POST /api/tasks/[id]/cancel — stop a turn, whether it has started or not.
 *
 * The two statuses need different inverses. A RUNNING turn can only be asked to
 * stop (the cooperative flag its worker polls). A QUEUED turn has no worker to ask
 * — the flag would sit unread until the chat's current reply finished and a worker
 * finally claimed the row just to finalize it as cancelled, which is minutes of a
 * follow-up the user already dismissed still showing as waiting. So a queued row is
 * removed outright; `cancelQueuedTurn` owns that, including the budget hold the row
 * carries and the finish event open clients need.
 *
 * The user MESSAGE the queued turn was going to answer stays in the transcript. It
 * is already persisted and the next turn rebuilds its context from the live tree, so
 * dismissing the turn drops the reply, never the words — deleting them here would be
 * a silent edit of the conversation nobody asked for.
 */
export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status, chatId: tasks.chatId })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);

  if (!task) return Response.json({ error: "Not found" }, { status: 404 });
  // Already finished — nothing to interrupt.
  if (task.status !== "running" && task.status !== "queued") {
    return Response.json({ ok: true, status: task.status });
  }

  if (task.status === "queued") {
    // Falls back to the flag on its own when a worker claimed the row in between.
    const outcome = await cancelQueuedTurn({ id, userId, chatId: task.chatId });
    return Response.json({ ok: true, outcome });
  }

  // Cross-process cooperative cancel: flip a DB flag the running worker polls.
  await requestCancel(id);

  return Response.json({ ok: true });
});
