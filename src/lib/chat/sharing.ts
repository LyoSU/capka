import { nanoid } from "nanoid";

/**
 * Chat sharing primitives — pure, DB-free, so the access policy is exhaustively
 * unit-testable. The DB-touching clone lives in tree.ts next to forkChat.
 */

/** The three sharing states stored in `chats.visibility`. */
export type Visibility = "private" | "link" | "users";

/** Whether `visibility` exposes the chat to anyone beyond its owner. */
export const SHARED_VISIBILITIES = ["link", "users"] as const;

export function isShared(visibility: string): visibility is "link" | "users" {
  return (SHARED_VISIBILITIES as readonly string[]).includes(visibility);
}

/**
 * Public share handle. Long + URL-safe so it can't be guessed or enumerated —
 * the whole point of a token over the chat id. Minted once on first publish and
 * then kept stable, so unpublish → re-publish reactivates the same URL.
 */
export function generateShareToken(): string {
  return nanoid(24);
}

/**
 * The outcome of a visitor hitting a public share URL, decided purely from the
 * chat's visibility and whether the visitor is signed in:
 *
 * - "ok"         → render the read-only conversation.
 * - "needs-auth" → the chat is shared, but only to signed-in users; send the
 *                  visitor to sign in, then back.
 * - "not-found"  → behave as if the chat doesn't exist (404). Used for the
 *                  private state AND any unknown value, so an unpublished chat
 *                  never even reveals that it exists.
 */
export type ShareAccess = "ok" | "needs-auth" | "not-found";

export function resolveShareAccess(visibility: string, hasSession: boolean): ShareAccess {
  switch (visibility) {
    // Anyone with the URL — session is irrelevant.
    case "link":
      return "ok";
    // Members only: signed-in visitors see it, others are sent to sign in and
    // come back (not a dead 404).
    case "users":
      return hasSession ? "ok" : "needs-auth";
    // "private" and any unrecognised value fall through to the safe outcome: a
    // private chat must be indistinguishable from one that never existed, so we
    // never return "needs-auth" here (that would leak that it exists).
    default:
      return "not-found";
  }
}
