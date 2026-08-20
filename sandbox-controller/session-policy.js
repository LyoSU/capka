/** A background job keeps running with nobody talking to the controller, so
 *  `lastActivity` stops meaning "in use" and the idle reaper would kill the
 *  container out from under it. A lease says "this session is busy until T" —
 *  expressed as a time, so it self-heals: a container that dies along with its
 *  job leaves an expiring lease, not a session pinned forever.
 *
 *  `busySince` anchors the ABSOLUTE ceiling. Without it a job that keeps getting
 *  renewed (a scraper stuck in retry) would hold compute indefinitely; with it,
 *  renewals stop extending once the window has run `maxMs` from its start.
 *  Returns both fields so the caller just writes them. Pure + unit-tested. */
export function nextBusyUntil({ busySince, busyUntil, now, leaseMs, maxMs }) {
  // An expired (or absent) lease opens a NEW window — the old ceiling is spent
  // and must not carry over to the next job.
  const held = busyUntil != null && busyUntil > now;
  const since = held ? busySince : now;
  return { busySince: since, busyUntil: Math.min(now + leaseMs, since + maxMs) };
}

/** When a user is at their concurrent-LIVE-container cap and needs another
 *  container (a brand-new workspace OR reviving a stopped one), pick the
 *  least-recently-used LIVE session to stop. Stopped workspaces (handle == null)
 *  don't count toward the cap — they hold no compute. The session being
 *  created/revived (`sessionId`) is excluded so we never evict ourselves.
 *  Returns null when under the cap (no eviction needed). Pure + unit-tested. */
export function pickLruVictim(liveSessions, maxLive, sessionId, now = Date.now()) {
  const others = liveSessions.filter((s) => s.handle != null && s.sessionId !== sessionId);
  if (others.length < maxLive) return null;
  // A leaseholder (background job running, see nextBusyUntil) is evicted only when
  // nothing else can be: killing it destroys work in progress, while evicting an
  // idle session costs a container restart. Busy is a LAST-RESORT POOL, not a
  // filter — with every session busy we still return a victim, because refusing
  // to evict would leave the user unable to open a chat at all.
  const free = others.filter((s) => !(s.busyUntil > now));
  const candidates = free.length > 0 ? free : others;
  // One-shot import containers (`imp-*`) are disposable, so sacrifice them before
  // any real chat sandbox — a preview render must never evict a live chat's
  // workspace. Only when no import session is live do we fall back to plain LRU.
  const imports = candidates.filter((s) => s.sessionId.startsWith("imp-"));
  const pool = imports.length > 0 ? imports : candidates;
  return pool.reduce((min, cur) => (cur.lastActivity < min.lastActivity ? cur : min));
}
