import { eq } from "drizzle-orm";
import { requireAdmin, apiHandler, type Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const GET = apiHandler(async () => {
  await requireAdmin();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, createdAt: users.createdAt })
    .from(users)
    .orderBy(users.createdAt);
  return Response.json(rows);
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
    return Response.json({ id: updated.id, status: updated.status });
  }

  if (!role) return Response.json({ error: "Missing role or status" }, { status: 400 });
  if (!["admin", "user", "viewer"].includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });

  const [updated] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
  if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
  return Response.json({ id: updated.id, role: updated.role });
});

// Reject (or remove) an account. Used for the "reject" action on pending users;
// cascades clean up their chats/links/etc. via the FK onDelete rules.
export const DELETE = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
  if (userId === adminId) return Response.json({ error: "Cannot delete own account" }, { status: 400 });
  const [deleted] = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  if (!deleted) return Response.json({ error: "User not found" }, { status: 404 });
  return Response.json({ ok: true });
});
