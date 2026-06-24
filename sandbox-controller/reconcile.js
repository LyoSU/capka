/** Reconcile durable session records (Postgres) against the live backend on boot.
 *
 *  A row represents a WORKSPACE, not necessarily a running container: `handle`
 *  may be null, meaning the workspace exists on disk but its container was
 *  reclaimed (idle eviction, host restart, …). Reconcile only ever reconciles
 *  COMPUTE — it clears a stale handle when the container is gone, but NEVER
 *  deletes a workspace row. Deleting a workspace (row + disk) is exclusively the
 *  TTL reaper's / orphan-dir GC's job. This is what keeps a user's files alive
 *  across restarts instead of vanishing once the container is gone.
 *
 *  `backend.list()` throwing (daemon unreachable) propagates BEFORE any record is
 *  touched, so the caller (boot's withRetry) retries with readiness still false —
 *  we never mutate records on a transient backend failure. */
export async function reconcile({ store, backend, destroy, markStopped }) {
  const doDestroy = destroy || ((handle) => backend.destroy(handle));
  const doStop = markStopped || ((id) => store.setStopped(id));
  const records = await store.all();
  const live = await backend.list(); // may throw — intentional (see above)

  const bySession = new Map(live.map((r) => [r.sessionId, r]));
  const recordIds = new Set(records.map((r) => r.sessionId));

  const kept = [];
  const stopped = [];
  const destroyedOrphans = [];

  // DB-driven rows
  for (const rec of records) {
    const b = bySession.get(rec.sessionId);
    if (b && b.running) {
      kept.push(rec.sessionId); // live container — leave it running
    } else {
      // No live container for this workspace. Tear down a stopped/dead container
      // if one lingers, then mark the workspace stopped (handle → null). Row stays.
      if (b) await doDestroy(b.handle);
      if (rec.handle != null) await doStop(rec.sessionId);
      stopped.push(rec.sessionId);
    }
  }

  // Backend-driven rows: containers with no DB record → orphans
  for (const b of live) {
    if (!recordIds.has(b.sessionId)) {
      await doDestroy(b.handle);
      destroyedOrphans.push(b.sessionId);
    }
  }

  return { kept, stopped, destroyedOrphans };
}
