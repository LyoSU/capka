import { eq, and, gte, sql, desc } from "drizzle-orm";
import { requireAdmin, apiHandler, type Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions, users, usage, tiers, chats, messages, capabilityPolicies, telegramLinks } from "@/lib/db/schema";
import { audit } from "@/lib/governance/audit";
import { getLimitStatus } from "@/lib/billing/limits";

const since30d = () => new Date(Date.now() - 30 * 86_400_000);

/**
 * Per-user drill-down for the drawer — fetched only when a row is opened, so the
 * list query stays lean. Spend across the tier's three windows (via the same
 * getLimitStatus the enforcement gate uses, so the numbers can't drift), turn
 * outcomes over 30d, the user's top models, and their live sessions.
 */
async function userDetail(userId: string): Promise<Response> {
  const since = since30d();
  const [limits, turnRows, models, activeSessions] = await Promise.all([
    getLimitStatus(userId),
    db
      .select({ st: sql<string>`${messages.metadata}->>'status'`, n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(eq(chats.userId, userId), eq(messages.role, "assistant"), gte(messages.createdAt, since)))
      .groupBy(sql`${messages.metadata}->>'status'`),
    db
      .select({ model: usage.model, cost: sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8`, calls: sql<number>`count(*)::int` })
      .from(usage)
      .where(and(eq(usage.userId, userId), eq(usage.pending, false), gte(usage.createdAt, since)))
      .groupBy(usage.model)
      .orderBy(desc(sql`coalesce(sum(${usage.costUsd}), 0)`))
      .limit(4),
    db
      .select({ id: sessions.id, createdAt: sessions.createdAt, updatedAt: sessions.updatedAt, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.updatedAt)),
  ]);

  const completed = turnRows.find((r) => r.st === "completed")?.n ?? 0;
  const failed = turnRows.find((r) => r.st === "failed")?.n ?? 0;
  return Response.json({
    tierName: limits.tierName,
    windows: limits.windows.map((w) => ({ window: w.window, used: w.used, limit: w.limit, pct: w.pct })),
    completed,
    failed,
    topModels: models.filter((m) => m.model).slice(0, 3),
    sessions: activeSessions,
  });
}

export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
  const detailId = new URL(req.url).searchParams.get("detail");
  if (detailId) return userDetail(detailId);

  const since = since30d();
  const [rows, spend, activity, turns, exceptions, tg, tierRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, createdAt: users.createdAt, tierId: users.tierId })
      .from(users)
      .orderBy(users.createdAt),
    // 30-day reconciled shared-key spend per user — "the org's bill for this
    // person", the number an admin actually acts on. Own-key spend is that
    // user's own money and never counts here.
    db
      .select({ userId: usage.userId, cost: sql<number>`coalesce(sum(${usage.costUsd}), 0)::float8` })
      .from(usage)
      .where(and(eq(usage.pending, false), eq(usage.onSharedKey, true), gte(usage.createdAt, since)))
      .groupBy(usage.userId),
    // Session activity, NOT login: updatedAt is refreshed while a session lives,
    // so the max is the last time we saw the user, not a guaranteed sign-in stamp.
    db.select({ userId: sessions.userId, last: sql<string | null>`max(${sessions.updatedAt})` }).from(sessions).groupBy(sessions.userId),
    // Logical turns: assistant messages that reached a terminal "completed"
    // status, attributed to the chat's owner. Read from messages (not tasks —
    // those are retention-pruned at 30 days and would truncate the window).
    db
      .select({ userId: chats.userId, n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(eq(messages.role, "assistant"), sql`${messages.metadata}->>'status' = 'completed'`, gte(messages.createdAt, since)))
      .groupBy(chats.userId),
    // Per-user capability exceptions (user-scoped policy rows) — the "N exceptions"
    // chip. groupBy leaves a null-userId bucket for any malformed rows; dropped below.
    db
      .select({ userId: capabilityPolicies.userId, n: sql<number>`count(*)::int` })
      .from(capabilityPolicies)
      .where(eq(capabilityPolicies.scope, "user"))
      .groupBy(capabilityPolicies.userId),
    db.selectDistinct({ userId: telegramLinks.userId }).from(telegramLinks),
    db
      .select({ id: tiers.id, name: tiers.name, limit5h: tiers.limit5h, limitWeek: tiers.limitWeek, limitMonth: tiers.limitMonth, isDefault: tiers.isDefault })
      .from(tiers)
      .orderBy(tiers.createdAt),
  ]);

  const cost = new Map(spend.map((s) => [s.userId, s.cost]));
  const last = new Map(activity.map((a) => [a.userId, a.last]));
  const turnMap = new Map(turns.map((t) => [t.userId, t.n]));
  const exMap = new Map(exceptions.filter((e) => e.userId).map((e) => [e.userId as string, e.n]));
  const tgSet = new Set(tg.map((t) => t.userId));

  return Response.json({
    users: rows.map((r) => ({
      ...r,
      cost30d: cost.get(r.id) ?? 0,
      lastActivityAt: last.get(r.id) ?? null,
      turns30d: turnMap.get(r.id) ?? 0,
      exceptionsCount: exMap.get(r.id) ?? 0,
      telegramConnected: tgSet.has(r.id),
    })),
    tiers: tierRows,
  });
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const body = (await req.json()) as { userId: string; role?: Role; status?: string; tierId?: string | null; revokeSessions?: boolean };
  const { userId, role, status } = body;

  if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
  // An admin can't change their OWN role/status (no self-lockout, no self-demote).
  if (userId === adminId && (role || status)) return Response.json({ error: "Cannot change own account" }, { status: 400 });

  // Lifecycle: approve/reactivate (active), send back to the approval queue
  // (pending), or revoke access (suspended). Any non-active status revokes the
  // user's live sessions in the SAME transaction as the flip, so a still-valid
  // cookie can't outlive the change. Reactivating does NOT revoke sessions.
  if (status) {
    if (!["active", "pending", "suspended"].includes(status)) return Response.json({ error: "Invalid status" }, { status: 400 });
    const result = await db.transaction(async (tx) => {
      // Prior status read in the same transaction: it decides whether "active"
      // means approving a pending signup or reactivating a suspended account —
      // two different audit events.
      const [before] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
      if (!before) return null;
      const [row] = await tx.update(users).set({ status }).where(eq(users.id, userId)).returning();
      if (!row) return null;
      if (status !== "active") {
        await tx.delete(sessions).where(eq(sessions.userId, userId));
      }
      return { row, prior: before.status };
    });
    if (!result) return Response.json({ error: "User not found" }, { status: 404 });
    const updated = result.row;
    const action =
      status === "suspended" ? "user.suspend"
      : status === "active" && result.prior === "suspended" ? "user.reactivate"
      : "user.status_change";
    await audit({ actorId: adminId, action, targetType: "user", targetKey: userId, detail: { status, name: updated.name ?? updated.email } });
    return Response.json({ id: updated.id, status: updated.status });
  }

  if (role) {
    if (!["admin", "user", "viewer"].includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });
    const [updated] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
    if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
    await audit({ actorId: adminId, action: "user.role_change", targetType: "user", targetKey: userId, detail: { role, name: updated.name ?? updated.email } });
    return Response.json({ id: updated.id, role: updated.role });
  }

  // Force-revoke every live session without changing status ("log this person out
  // everywhere"). Distinct from suspend, which also flips the status.
  if (body.revokeSessions) {
    const [subject] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!subject) return Response.json({ error: "User not found" }, { status: 404 });
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await audit({ actorId: adminId, action: "user.sessions_revoke", targetType: "user", targetKey: userId, detail: { name: subject.name ?? subject.email } });
    return Response.json({ ok: true });
  }

  // Personal spend-tier assignment. null tierId → back to the instance default.
  if ("tierId" in body) {
    const tierId = body.tierId || null;
    if (tierId) {
      const [t] = await db.select({ id: tiers.id }).from(tiers).where(eq(tiers.id, tierId)).limit(1);
      if (!t) return Response.json({ error: "Tier not found" }, { status: 404 });
    }
    const [updated] = await db
      .update(users)
      .set({ tierId, tierSource: "manual" })
      .where(eq(users.id, userId))
      .returning({ id: users.id, tierId: users.tierId, name: users.name, email: users.email });
    if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
    await audit({ actorId: adminId, action: "user.tier_change", targetType: "user", targetKey: userId, detail: { tierId, name: updated.name ?? updated.email } });
    return Response.json({ id: updated.id, tierId: updated.tierId });
  }

  return Response.json({ error: "Missing role, status, or tierId" }, { status: 400 });
});

// Reject (or remove) an account. Used for the "reject" action on pending users
// and delete from the drawer; cascades clean up their chats/links/etc. via FKs.
export const DELETE = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
  if (userId === adminId) return Response.json({ error: "Cannot delete own account" }, { status: 400 });
  const [deleted] = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id, name: users.name, email: users.email });
  if (!deleted) return Response.json({ error: "User not found" }, { status: 404 });
  await audit({ actorId: adminId, action: "user.remove", targetType: "user", targetKey: userId, detail: { name: deleted.name ?? deleted.email } });
  return Response.json({ ok: true });
});
