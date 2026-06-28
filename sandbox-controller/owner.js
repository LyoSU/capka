import { createHmac, timingSafeEqual } from "node:crypto";
import { sanitize } from "./path-safety.js";

/** Constant-time string compare that tolerates length mismatch. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** HMAC over a sanitized userId+sessionId pair. Lets file ops trust a workspace
 *  owner even with no running container: the platform derives the same token from
 *  the shared secret, so possession of the secret AND the correct user↔session
 *  binding is required — not merely knowledge of a sessionId. */
export function workspaceToken(secret, userId, sessionId) {
  return createHmac("sha256", secret)
    .update(`${sanitize(userId)}|${sanitize(sessionId)}`)
    .digest("hex");
}

/** Decide the owner of a file operation. Pure (no I/O) so it is unit-testable;
 *  the caller fetches `session` from the store and passes it in.
 *
 *  EVERY file op — live session or stopped — must carry the caller's userId and a
 *  valid HMAC token bound to userId+sessionId. The token proves possession of the
 *  shared secret AND the user↔session binding; the bearer secret alone is not
 *  enough. A workspace is keyed by its project and owned by a single user (every
 *  chat in a project shares that owner), so the verified caller userId must equal
 *  a live session's stored owner — a token minted for a different user must never
 *  reach this owner's files just because the container happens to be running.
 *  Creation already pins single-owner-per-session (POST /sessions returns 403 on a
 *  userId mismatch), so for a live session this is a redundant but cheap re-check.
 *
 *  Returns { userId, sessionId } | { missing: true } | { forbidden: true }. */
export function resolveOwnerDecision({ session, sessionId, fallbackUserId, token, secret }) {
  if (!fallbackUserId) return { missing: true };
  if (!token || !safeEqual(workspaceToken(secret, fallbackUserId, sessionId), token)) {
    return { forbidden: true };
  }
  const userId = sanitize(fallbackUserId);
  // A live session has a pinned owner: the verified caller must be that owner.
  if (session && session.userId !== userId) return { forbidden: true };
  return { userId, sessionId: sanitize(sessionId) };
}
