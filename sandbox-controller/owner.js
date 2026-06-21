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
 *  - Live session: its stored OWNER wins — and deliberately so. A project workspace
 *    is shared: a chat is keyed by its projectId, the session is owned by whoever
 *    created it first, and other project members (each authorized upstream by the
 *    platform's requireOwned) browse that same owner's folder. Resolving to the
 *    session owner regardless of the requesting userId is what implements the
 *    "shared project folder". The supplied userId is therefore NOT cross-checked
 *    here; per-user authorization is the platform's responsibility (it holds the
 *    secret and gates every call). Creation already pins single-owner-per-session
 *    (POST /sessions returns 403 on a userId mismatch).
 *  - No live session: there is no owner to trust, so require a valid HMAC token
 *    bound to the supplied userId+sessionId.
 *
 *  Returns { userId, sessionId } | { missing: true } | { forbidden: true }. */
export function resolveOwnerDecision({ session, sessionId, fallbackUserId, token, secret }) {
  if (session) return { userId: session.userId, sessionId: session.sessionId };
  if (!fallbackUserId) return { missing: true };
  if (!token || !safeEqual(workspaceToken(secret, fallbackUserId, sessionId), token)) {
    return { forbidden: true };
  }
  return { userId: sanitize(fallbackUserId), sessionId: sanitize(sessionId) };
}
