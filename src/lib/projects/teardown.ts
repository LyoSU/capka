import { and, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, attachedFolders } from "@/lib/db/schema";
import { destroySession } from "@/lib/sandbox/client";
import { retireProjectSpace } from "@/lib/vault/spaces";
import { log } from "@/lib/log";

/** Finish deleting a tombstoned project: tear down its sandbox + workspace, detach
 *  its folders, then physically remove the row (FK cascades drop its skills,
 *  connectors, policies and memory; chats/automations were already reset/paused in
 *  the delete transaction). Idempotent — every step tolerates being run again after
 *  a partial failure, so the worker retry can safely re-drive it. A project's
 *  workspace session key IS the project id (workspaceSessionKey). */
export async function teardownProject(project: { id: string; userId: string }): Promise<void> {
  // Kill the container (if any) and wipe the workspace directory. Idempotent on the
  // controller (a missing session/dir is a no-op).
  await destroySession(project.id, project.userId);
  // Detach the project's folders — only the attachment rows; the originals on the
  // host / the user's PC are never touched. No FK links these to the project (the
  // key is the string sessionKey), so they must be deleted explicitly.
  await db.delete(attachedFolders).where(eq(attachedFolders.sessionKey, project.id));
  // The project's vault memory dies with it; its knowledge does not — chats
  // outlive the project (projectId is SET NULL) and their citations still pin
  // those source versions, so sources are only soft-deleted. No FK links a space
  // to the project (ref_id is polymorphic), so this is an explicit step, and it
  // is a no-op on a re-drive.
  await retireProjectSpace(project.id);
  // Physical delete — FK cascades (skills, connectors, policies, memory) and the
  // set-null on chats/automations fire here. Guarded on deletedAt so a project that
  // was somehow un-tombstoned in the meantime isn't destroyed.
  await db.delete(projects).where(and(eq(projects.id, project.id), isNotNull(projects.deletedAt)));
}

/** Worker tick: finish any project left tombstoned by a delete whose post-commit
 *  teardown failed (controller blip, crash between commit and teardown). A short
 *  grace avoids racing the request's own teardown for a just-committed delete. */
export async function retryPendingProjectTeardowns(graceMs = 30_000): Promise<void> {
  const cutoff = new Date(Date.now() - graceMs);
  const stale = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, cutoff)));
  for (const p of stale) {
    try {
      await teardownProject(p);
      log.info("project teardown retried", { projectId: p.id });
    } catch (e) {
      log.error("project teardown retry failed", { projectId: p.id, err: String(e) });
    }
  }
}
