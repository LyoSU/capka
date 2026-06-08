import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { requestCancel } from "@/lib/tasks/queue";

export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;

  const [task] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);

  if (!task) return Response.json({ error: "Not found" }, { status: 404 });
  // Already finished (or queued-but-not-started) — nothing to interrupt.
  if (task.status !== "running" && task.status !== "queued") {
    return Response.json({ ok: true, status: task.status });
  }

  // Cross-process cooperative cancel: flip a DB flag the running worker polls.
  // Whichever worker (or none yet) owns the task will observe it and stop.
  await requestCancel(id);

  return Response.json({ ok: true });
});
