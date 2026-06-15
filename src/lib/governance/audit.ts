import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type { AuditAction, AuditEntry } from "./types";

/** Record a governance-relevant action. Best-effort: a logging failure must never
 *  break the action it describes. */
export async function audit(e: {
  actorId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetKey?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(), actorId: e.actorId ?? null, action: e.action,
      targetType: e.targetType ?? null, targetKey: e.targetKey ?? null, detail: e.detail ?? {},
    });
  } catch (err) {
    console.warn("[audit] failed to record", e.action, err);
  }
}

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id, actorId: r.actorId, action: r.action,
    targetType: r.targetType, targetKey: r.targetKey, detail: r.detail ?? {}, createdAt: r.createdAt,
  }));
}
