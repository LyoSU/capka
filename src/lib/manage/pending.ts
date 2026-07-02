import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { managePending } from "@/lib/db/schema";

/** A staged, human-authorized-on-apply mutation. `apply` runs a fresh change,
 *  `undo` restores a prior value — both consumed only via a path the human
 *  controls (web session / Telegram callback), never by the model. */
export type PendingKind = "apply" | "undo";

export interface PendingRecord {
  userId: string;
  projectId: string | null;
  kind: PendingKind;
  /** The exact mutation to run — so the applied change can't be swapped for a
   *  different one (this replaces the old argsHash binding). */
  payload: Record<string, unknown>;
}

export interface PendingStore {
  /** Persist a staged action, returning its opaque id (safe to expose — useless
   *  without the session/callback that authorizes consuming it). */
  stage(rec: PendingRecord, ttlMs?: number): Promise<string>;
  /** Atomically claim the row for `userId` exactly once. Returns null if it's
   *  missing, expired, already consumed, or owned by another user (no leak). */
  consume(id: string, userId: string): Promise<PendingRecord | null>;
  /** Drop a staged action the user cancelled (best-effort). */
  cancel(id: string, userId: string): Promise<void>;
  /** Read-only status for THIS user's card, so a reloaded confirm card reflects
   *  reality instead of showing live buttons for an already-applied change.
   *  `gone` = never existed, cancelled, or cleaned up past its TTL. */
  peek(id: string, userId: string): Promise<PendingStatus>;
}

export type PendingStatus = "open" | "applied" | "expired" | "gone";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export const dbPendingStore: PendingStore = {
  async stage(rec, ttlMs = DEFAULT_TTL_MS) {
    const id = nanoid();
    await db.insert(managePending).values({
      id,
      userId: rec.userId,
      projectId: rec.projectId,
      kind: rec.kind,
      payload: rec.payload,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return id;
  },

  async consume(id, userId) {
    const now = new Date();
    // Single-use latch in one statement: only an unconsumed, unexpired row owned
    // by this user flips to consumed and comes back — so a double-tap (or a race
    // between the web button and a Telegram callback) can apply at most once.
    const [row] = await db
      .update(managePending)
      .set({ consumedAt: now })
      .where(
        and(
          eq(managePending.id, id),
          eq(managePending.userId, userId),
          isNull(managePending.consumedAt),
          gt(managePending.expiresAt, now),
        ),
      )
      .returning();
    // Opportunistic cleanup of anything past its TTL (harmless if it races).
    void db.delete(managePending).where(lt(managePending.expiresAt, now)).catch(() => {});
    if (!row) return null;
    return { userId: row.userId, projectId: row.projectId, kind: row.kind as PendingKind, payload: row.payload };
  },

  async cancel(id, userId) {
    await db.delete(managePending).where(and(eq(managePending.id, id), eq(managePending.userId, userId)));
  },

  async peek(id, userId) {
    const [row] = await db
      .select({ consumedAt: managePending.consumedAt, expiresAt: managePending.expiresAt })
      .from(managePending)
      .where(and(eq(managePending.id, id), eq(managePending.userId, userId)))
      .limit(1);
    if (!row) return "gone";
    if (row.consumedAt) return "applied";
    if (row.expiresAt <= new Date()) return "expired";
    return "open";
  },
};
