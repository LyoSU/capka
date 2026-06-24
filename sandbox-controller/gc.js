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

/** Reap workspaces unused for longer than the (long) workspace TTL: delete the
 *  row AND its on-disk dir, stopping any lingering container first. This is the
 *  ONLY path that destroys a user's files — idle eviction merely stops the
 *  container (handle → null) and leaves the workspace alone, so files survive
 *  short gaps and restarts. `lastActivity` reflects real use (exec/file ops), so
 *  the clock only advances while a workspace sits truly idle. Idempotent. */
export async function reapStaleWorkspaces({ store, backend, workspace, ttlMs, now = Date.now(), log }) {
  let reaped = 0;
  for (const s of await store.all()) {
    if (now - s.lastActivity <= ttlMs) continue;
    if (s.handle != null) await Promise.resolve(backend.destroy(s.handle)).catch(() => {});
    await store.delete(s.sessionId);
    await workspace.remove(s.userId, s.sessionId);
    reaped++;
    log?.("workspace.reap", { userId: s.userId, sessionId: s.sessionId });
  }
  return { reaped };
}

/** Garbage-collect TRULY orphaned workspaces: directories on disk with no row in
 *  Postgres at all (e.g. pre-migration leftovers or manual junk), older than a
 *  grace window. Stopped workspaces still HAVE a row, so they are NOT touched
 *  here — only the TTL reaper removes those. Idempotent; logs each removal. */
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
