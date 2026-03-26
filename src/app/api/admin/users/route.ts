import { eq } from "drizzle-orm";
import { requireAdmin, apiHandler, type Role } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const GET = apiHandler(async () => {
  await requireAdmin();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users)
    .orderBy(users.createdAt);
  return Response.json(rows);
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId: adminId } = await requireAdmin();
  const { userId, role } = await req.json() as { userId: string; role: Role };

  if (!userId || !role) return Response.json({ error: "Missing userId or role" }, { status: 400 });
  if (!["admin", "user", "viewer"].includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });
  if (userId === adminId) return Response.json({ error: "Cannot change own role" }, { status: 400 });

  const [updated] = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
  if (!updated) return Response.json({ error: "User not found" }, { status: 404 });
  return Response.json({ id: updated.id, role: updated.role });
});
