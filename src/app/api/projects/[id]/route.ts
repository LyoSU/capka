import { eq, and, inArray, sql } from "drizzle-orm";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats, tasks, automations, attachedFolders, skills, mcpServers } from "@/lib/db/schema";
import { projectUpdateSchema } from "@/lib/projects/schema";
import { requireLiveProject } from "@/lib/projects/live";
import { teardownProject } from "@/lib/projects/teardown";
import { log } from "@/lib/log";

// A rolled-back tombstone (a task slipped in between the pre-check and the commit).
class TasksAppearedError extends Error {}

export const GET = apiHandler(async (_req, { params }) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const project = await requireLiveProject(id, userId);

  // Inventory for the delete dialog + hub overview. Separate scalar subqueries so
  // no count multiplies another (see the list route). Automations counts only the
  // enabled ones — those are what "will be paused" on delete.
  const [counts] = await db
    .select({
      chatCount: sql<number>`(select count(*)::int from ${chats} where ${chats.projectId} = ${id} and ${chats.archived} = false)`,
      lastChatAt: sql<Date | null>`(select max(${chats.updatedAt}) from ${chats} where ${chats.projectId} = ${id} and ${chats.archived} = false)`,
      connectorCount: sql<number>`(select count(*)::int from ${mcpServers} where ${mcpServers.projectId} = ${id})`,
      skillCount: sql<number>`(select count(*)::int from ${skills} where ${skills.projectId} = ${id})`,
      automationCount: sql<number>`(select count(*)::int from ${automations} where ${automations.projectId} = ${id} and ${automations.enabled} = true)`,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  return Response.json({ ...project, ...counts });
});

export const PUT = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireLiveProject(id, userId);

  const body = projectUpdateSchema.parse(await req.json());
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.systemPrompt !== undefined) updates.systemPrompt = body.systemPrompt?.trim() || null;
  if (body.defaultModel !== undefined) updates.defaultModel = body.defaultModel?.trim() || null;
  if (body.sandboxNetwork !== undefined) updates.sandboxNetwork = body.sandboxNetwork;

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .returning();

  return Response.json(updated);
});

export const DELETE = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireLiveProject(id, userId);

  // Precondition: refuse while work is live against the shared workspace — a
  // running turn or an in-progress folder sync could be mid-write when we wipe it.
  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .innerJoin(chats, eq(tasks.chatId, chats.id))
    .where(and(eq(chats.projectId, id), inArray(tasks.status, ["queued", "running"])));
  if (active && active.n > 0) {
    return Response.json({ error: "A chat in this project is still working.", code: "TASK_RUNNING" }, { status: 409 });
  }
  const [syncing] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attachedFolders)
    .where(and(eq(attachedFolders.sessionKey, id), sql`(${attachedFolders.syncLease}->>'expiresAt')::timestamptz > now()`));
  if (syncing && syncing.n > 0) {
    return Response.json({ error: "A folder in this project is still syncing.", code: "SYNC_ACTIVE" }, { status: 409 });
  }

  // Tombstone transaction: pause automations (so none keeps firing without the
  // project's files/memory/connectors) and set deletedAt — after commit the project
  // vanishes from every query (they all filter deletedAt is null). The active-task
  // check is REPEATED inside the transaction (after the tombstone write): a turn
  // that got enqueued between the pre-check above and here forces a rollback, so we
  // never wipe a workspace with a turn already claimed against it. This narrows the
  // race to the claim boundary — combined with the create/run-time liveness checks
  // (a new turn can't enqueue into a tombstoned project), no separate lock is needed.
  try {
    await db.transaction(async (tx) => {
      await tx.update(automations).set({ enabled: false, nextRunAt: null, updatedAt: new Date() }).where(eq(automations.projectId, id));
      await tx.update(projects).set({ deletedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, userId)));
      const [live] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(tasks)
        .innerJoin(chats, eq(tasks.chatId, chats.id))
        .where(and(eq(chats.projectId, id), inArray(tasks.status, ["queued", "running"])));
      if (live && live.n > 0) throw new TasksAppearedError();
    });
  } catch (e) {
    if (e instanceof TasksAppearedError) {
      return Response.json({ error: "A chat in this project is still working.", code: "TASK_RUNNING" }, { status: 409 });
    }
    throw e;
  }

  // Post-commit teardown: kill the sandbox, wipe the workspace, detach folders, then
  // physically delete the row. On failure the row stays tombstoned (already hidden)
  // and the worker tick retries — so we still report success to the caller.
  try {
    await teardownProject({ id, userId });
  } catch (e) {
    log.error("project teardown failed (tombstoned; worker will retry)", { projectId: id, err: String(e) });
  }

  return new Response(null, { status: 204 });
});
