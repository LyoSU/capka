/** Workspace disk-quota tracker — the app-level guard against an agent filling
 *  the shared host disk through its bind-mounted /workspace.
 *
 *  WHY this exists: a process inside the sandbox writes straight to the bind
 *  mount, so it bypasses the controller's upload-path quota check entirely, and
 *  Docker bind mounts can't carry a size cap. The *real* fix is a kernel quota on
 *  DATA_ROOT (XFS/ext4 project quota) — see docs. Where that isn't available
 *  (e.g. a stock ext4 VPS) this tracker is the enforcement: the exec handler
 *  asks `isOverQuota` before running a command and refuses once a workspace is at
 *  or over the cap. It bounds *accumulation across commands* and stops an
 *  already-full session; it cannot stop a single runaway command mid-write (only
 *  a kernel quota does that), so it's a safety net, not a hard wall.
 *
 *  Walking the tree (`size`) is expensive, so results are cached for `ttlMs` to
 *  keep du off the hot exec path and coalesce bursts. The GC pass already sizes
 *  every workspace each tick; it feeds those measurements back via `note()`, so
 *  the cache stays warm for free.
 */
export function createQuotaTracker({ size, limitBytes, ttlMs = 5000, now = Date.now }) {
  const cache = new Map(); // sessionId -> { bytes, at }
  const disabled = !(limitBytes > 0);

  async function bytesFor(userId, sessionId) {
    const hit = cache.get(sessionId);
    if (hit && now() - hit.at < ttlMs) return hit.bytes;
    const bytes = await size(userId, sessionId);
    cache.set(sessionId, { bytes, at: now() });
    return bytes;
  }

  return {
    /** True when the workspace is at or over the cap. Cached for ttlMs. A
     *  non-positive limit disables the check (returns false without any du). */
    async isOverQuota(userId, sessionId) {
      if (disabled) return false;
      return (await bytesFor(userId, sessionId)) >= limitBytes;
    },
    /** Seed the cache with a freshly-measured size (e.g. from the GC pass) so the
     *  next isOverQuota answers without walking the tree again. */
    note(sessionId, bytes) {
      cache.set(sessionId, { bytes, at: now() });
    },
    /** Drop a session's cached size (on evict/reap) so a recycled id never reads
     *  a stale measurement. */
    forget(sessionId) {
      cache.delete(sessionId);
    },
  };
}
