import { nanoid } from "nanoid";
import type { PendingRecord, PendingStore } from "../pending";

type Row = PendingRecord & { expiresAt: number; consumed: boolean };

/** In-memory PendingStore for dispatch tests — mirrors the DB store's contract
 *  (single-use, owner-bound, TTL) without a database. */
export function memPendingStore(): PendingStore {
  const rows = new Map<string, Row>();
  return {
    async stage(rec, ttlMs = 600_000) {
      const id = nanoid();
      rows.set(id, { ...rec, expiresAt: Date.now() + ttlMs, consumed: false });
      return id;
    },
    async consume(id, userId) {
      const r = rows.get(id);
      if (!r || r.consumed || r.userId !== userId || r.expiresAt <= Date.now()) return null;
      r.consumed = true;
      return { userId: r.userId, projectId: r.projectId, kind: r.kind, payload: r.payload };
    },
    async cancel(id, userId) {
      const r = rows.get(id);
      if (r && r.userId === userId) rows.delete(id);
    },
    async peek(id, userId) {
      const r = rows.get(id);
      if (!r || r.userId !== userId) return "gone";
      if (r.consumed) return "applied";
      if (r.expiresAt <= Date.now()) return "expired";
      return "open";
    },
  };
}
