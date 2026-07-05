import { desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditLog, users } from "@/lib/db/schema";
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

/** Newest-first page of the audit trail, with the actor resolved to a human
 *  name/email so the UI can say WHO did each thing. A left join keeps rows
 *  whose actor was a system action or a since-deleted user. */
export async function listAudit(limit = 100, offset = 0, actions?: readonly string[]): Promise<AuditEntry[]> {
  const rows = await db
    .select({
      id: auditLog.id, actorId: auditLog.actorId,
      actorName: users.name, actorEmail: users.email,
      action: auditLog.action, targetType: auditLog.targetType, targetKey: auditLog.targetKey,
      detail: auditLog.detail, createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(actions && actions.length ? inArray(auditLog.action, actions as string[]) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.id, actorId: r.actorId, actorName: r.actorName, actorEmail: r.actorEmail, action: r.action,
    targetType: r.targetType, targetKey: r.targetKey, detail: r.detail ?? {}, createdAt: r.createdAt,
  }));
}
