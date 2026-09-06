import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { appendSteer, STEER_MAX_CHARS, STEER_MAX_PER_TURN } from "@/lib/tasks/queue";

/**
 * POST /api/tasks/[id]/steer — add an instruction to a turn that is already running.
 *
 * The third way to send a message, and the only one that changes nothing about the
 * turn: it is not a new turn (queue), and it does not stop this one (interrupt) —
 * the runner folds the text into the prompt of the very next step. So the outcome
 * this endpoint owes the client is precise: `tooLate` means the turn can no longer
 * read it and the message must be sent the ordinary way, which is exactly what the
 * composer falls back to.
 *
 * The id is the CLIENT's, not ours: it draws the steer on the timeline before this
 * request resolves, and the same id coming back in the turn's snapshot is what
 * retires the optimistic row.
 */
const steerSchema = z.object({ id: z.string().min(1).max(64), text: z.string().min(1) });

export const POST = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  const body = steerSchema.parse(await req.json());

  // Length is checked before the row is touched so an oversized paste is refused
  // for what it is, rather than as a generic failure of the append.
  if (body.text.length > STEER_MAX_CHARS) {
    return Response.json({ outcome: "tooLong", limit: STEER_MAX_CHARS }, { status: 413 });
  }

  // Ownership first, so a task id belonging to someone else reads as absent rather
  // than as a turn that has finished (the append's own WHERE enforces it too — this
  // is what makes the two failures distinguishable).
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
    .limit(1);
  if (!task) return Response.json({ error: "Not found" }, { status: 404 });

  const outcome = await appendSteer(id, userId, { id: body.id, text: body.text, at: new Date().toISOString() });
  if (outcome === "tooMany") {
    return Response.json({ outcome, limit: STEER_MAX_PER_TURN }, { status: 429 });
  }
  // 409, not 404: the turn existed and the caller was not wrong to try — it simply
  // finished first, and the client has a real next move (send it as its own turn).
  if (outcome === "tooLate") return Response.json({ outcome }, { status: 409 });

  return Response.json({ outcome: "ok" });
});
