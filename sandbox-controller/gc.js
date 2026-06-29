/** Live workspaces whose on-disk size exceeds the soft quota. REPORTING ONLY: a
 *  process inside the sandbox writes to its bind-mounted /workspace directly, so it
 *  can blow past MAX_WORKSPACE_MB regardless of the controller's upload-path check
 *  (which only guards uploads *through* the controller). Real enforcement is a
 *  host-level concern — an XFS project quota on DATA_ROOT, or a per-session volume
 *  with a size cap. This surfaces the breach so ops can alert, without destroying a
 *  (possibly non-technical) user's work mid-task. */
export async function findOverQuota({ store, workspace, limitBytes, onSize }) {
  const over = [];
  for (const s of await store.all()) {
    const bytes = await workspace.size(s.userId, s.sessionId);
    // Feed every measurement to the live quota tracker so its cache stays warm
    // without a second du on the exec path (see workspace-quota.js).
    onSize?.(s.sessionId, bytes);
    if (bytes > limitBytes) over.push({ sessionId: s.sessionId, userId: s.userId, bytes });
  }
  return over;
}

/** Decide which over-quota workspaces to log THIS pass, so the breach is recorded
 *  once per crossing instead of on every sweep (the old code logged all of them
 *  every tick — pure spam). Mutates `warned` to match the current breach set:
 *  a workspace that dropped back under quota is forgotten, so if it later crosses
 *  again it warns afresh. Pure but for the `warned` set it owns. */
export function quotaWarnings(over, warned) {
  const overIds = new Set(over.map((o) => o.sessionId));
  for (const id of [...warned]) if (!overIds.has(id)) warned.delete(id); // recovered
  const toWarn = over.filter((o) => !warned.has(o.sessionId));
  for (const o of toWarn) warned.add(o.sessionId);
  return toWarn;
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

/** Reclaim disk from REGENERABLE build/dependency dirs (node_modules, .venv,
 *  __pycache__, site-packages, …) in workspaces that are over the soft quota,
 *  WITHOUT deleting the user's actual files. Tightly gated so it never surprises
 *  anyone: only workspaces whose container is stopped (`handle == null` → no
 *  process is using the deps), that have been idle past `idleMs`, AND that are
 *  actually over quota. A workspace under quota is left untouched; an active or
 *  recently-used one is left untouched. The deps simply reinstall on the next run
 *  — and only over-quota workspaces, which couldn't run until freed anyway, ever
 *  pay that. `prune(userId, sessionId)` removes the regenerable dirs; freed bytes
 *  are measured as size-before − size-after so it works for any store. */
export async function reclaimRegenerable({ store, workspace, limitBytes, idleMs, prune, now = Date.now(), log }) {
  let reclaimed = 0;
  for (const s of await store.all()) {
    if (s.handle != null) continue;              // container live → deps may be in use
    if (now - s.lastActivity <= idleMs) continue; // not idle long enough
    const before = await workspace.size(s.userId, s.sessionId);
    if (before <= limitBytes) continue;          // under quota → nothing to reclaim
    await prune(s.userId, s.sessionId);
    const freed = before - (await workspace.size(s.userId, s.sessionId));
    if (freed > 0) {
      reclaimed += freed;
      log?.("workspace.reclaim", { userId: s.userId, sessionId: s.sessionId, freedMb: Math.round(freed / 1048576) });
    }
  }
  return { reclaimed };
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
    // Re-check liveness right before the destructive remove: the snapshot above is
    // stale by the time we get here, so a session created/revived mid-pass would
    // otherwise have its fresh workspace wiped (TOCTOU). A row now means it's owned.
    if (await store.get(ws.sessionId)) continue;
    await workspace.remove(ws.userId, ws.sessionId);
    removed++;
    log?.("gc", { userId: ws.userId, sessionId: ws.sessionId });
  }
  return { removed };
}
