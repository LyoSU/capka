import { eq, and, gte, sql } from "drizzle-orm";
import { requireAdmin, apiHandler, type Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, usage } from "@/lib/db/schema";
import { audit } from "@/lib/governance/audit";

export const GET = apiHandler(async () => {
  await requireAdmin();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [rows, spend] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, createdAt: users.createdAt })
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
  ]);
  const cost = new Map(spend.map((s) => [s.userId, s.cost]));
  return Response.json(rows.map((r) => ({ ...r, cost30d: cost.get(r.id) ?? 0 })));
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const { userId, role, status } = await req.json() as { userId: string; role?: Role; status?: "active" | "pending" };

  if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
  if (userId === adminId && (role || status)) return Response.json({ error: "Cannot change own account" }, { status: 400 });

  // Approve a pending account (registration_mode = "approval").
  if (status) {
    if (!["active", "pending"].includes(status)) return Response.json({ error: "Invalid status" }, { status: 400 });
    const [updated] = await db.update(users).set({ status }).where(eq(users.id, userId)).returning();
    if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
    await audit({ actorId: adminId, action: "user.status_change", targetType: "user", targetKey: userId, detail: { status, name: updated.name ?? updated.email } });
    return Response.json({ id: updated.id, status: updated.status });
  }

  if (!role) return Response.json({ error: "Missing role or status" }, { status: 400 });
  if (!["admin", "user", "viewer"].includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });

  const [updated] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
  if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
  await audit({ actorId: adminId, action: "user.role_change", targetType: "user", targetKey: userId, detail: { role, name: updated.name ?? updated.email } });
  return Response.json({ id: updated.id, role: updated.role });
});

// Reject (or remove) an account. Used for the "reject" action on pending users;
// cascades clean up their chats/links/etc. via the FK onDelete rules.
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
