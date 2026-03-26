import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { cancelTask } from "@/lib/tasks/runner";

export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);

  if (!task) return Response.json({ error: "Not found" }, { status: 404 });
  if (task.status !== "running") return Response.json({ ok: true, status: task.status });

  const cancelled = cancelTask(id);
  if (!cancelled) {
    // Task not in memory (server restarted?) — mark as cancelled in DB
    await db.update(tasks).set({ status: "cancelled", updatedAt: new Date() }).where(eq(tasks.id, id));
  }

  return Response.json({ ok: true });
});
