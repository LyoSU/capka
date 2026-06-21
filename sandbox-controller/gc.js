/** Live workspaces whose on-disk size exceeds the soft quota. REPORTING ONLY: a
 *  process inside the sandbox writes to its bind-mounted /workspace directly, so it
 *  can blow past MAX_WORKSPACE_MB regardless of the controller's upload-path check
 *  (which only guards uploads *through* the controller). Real enforcement is a
 *  host-level concern — an XFS project quota on DATA_ROOT, or a per-session volume
 *  with a size cap. This surfaces the breach so ops can alert, without destroying a
 *  (possibly non-technical) user's work mid-task. */
export async function findOverQuota({ store, workspace, limitBytes }) {
  const over = [];
  for (const s of await store.all()) {
    const bytes = await workspace.size(s.userId, s.sessionId);
    if (bytes > limitBytes) over.push({ sessionId: s.sessionId, userId: s.userId, bytes });
  }
  return over;
}

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
