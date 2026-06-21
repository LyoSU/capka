/** Garbage-collect orphaned workspaces: directories on disk whose session is no
 *  longer in Postgres and older than a grace window. Without this, evicted/idle
 *  sessions leave their workspace dirs forever and fill the disk on a shared host.
 *  Idempotent; logs each removal. */
export async function gcOrphanWorkspaces({ store, workspace, listOnDisk, graceMs, now = Date.now(), log }) {
  const live = new Set((await store.all()).map((r) => r.sessionId));
  const onDisk = await listOnDisk();
  let removed = 0;
  for (const ws of onDisk) {
    if (live.has(ws.sessionId)) continue;
    if (now - ws.mtimeMs <= graceMs) continue; // young orphan, keep within grace
    await workspace.remove(ws.userId, ws.sessionId);
    removed++;
    log?.("gc", { userId: ws.userId, sessionId: ws.sessionId });
  }
  return { removed };
}
