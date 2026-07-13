/** When a user is at their concurrent-LIVE-container cap and needs another
 *  container (a brand-new workspace OR reviving a stopped one), pick the
 *  least-recently-used LIVE session to stop. Stopped workspaces (handle == null)
 *  don't count toward the cap — they hold no compute. The session being
 *  created/revived (`sessionId`) is excluded so we never evict ourselves.
 *  Returns null when under the cap (no eviction needed). Pure + unit-tested. */
export function pickLruVictim(liveSessions, maxLive, sessionId) {
  const others = liveSessions.filter((s) => s.handle != null && s.sessionId !== sessionId);
  if (others.length < maxLive) return null;
  // One-shot import containers (`imp-*`) are disposable, so sacrifice them before
  // any real chat sandbox — a preview render must never evict a live chat's
  // workspace. Only when no import session is live do we fall back to plain LRU.
  const imports = others.filter((s) => s.sessionId.startsWith("imp-"));
  const pool = imports.length > 0 ? imports : others;
  return pool.reduce((min, cur) => (cur.lastActivity < min.lastActivity ? cur : min));
}
