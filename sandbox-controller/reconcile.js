/** Reconcile durable session records (Postgres) against the live backend on boot.
 *  Implements the spec §14 table. Returns a summary for logging. `backend.list()`
 *  throwing (daemon unreachable) propagates so the caller leaves readiness false
 *  and retries — we never delete records on a transient backend failure. */
export async function reconcile({ store, backend, destroy }) {
  const doDestroy = destroy || ((handle) => backend.destroy(handle));
  const records = await store.all();
  const live = await backend.list(); // may throw — intentional (see above)

  const bySession = new Map(live.map((r) => [r.sessionId, r]));
  const recordIds = new Set(records.map((r) => r.sessionId));

  const kept = [];
  const removedRecords = [];
  const destroyedOrphans = [];

  // DB-driven rows
  for (const rec of records) {
    const b = bySession.get(rec.sessionId);
    if (b && b.running) {
      kept.push(rec.sessionId);
    } else if (!b) {
      // PG yes / backend no → zombie record
      await store.delete(rec.sessionId);
      removedRecords.push(rec.sessionId);
    } else {
      // PG yes / backend stopped → clean up both
      await doDestroy(b.handle);
      await store.delete(rec.sessionId);
      removedRecords.push(rec.sessionId);
    }
  }

  // Backend-driven rows: containers with no DB record → orphans
  for (const b of live) {
    if (!recordIds.has(b.sessionId)) {
      await doDestroy(b.handle);
      destroyedOrphans.push(b.sessionId);
    }
  }

  return { kept, removedRecords, destroyedOrphans };
}
