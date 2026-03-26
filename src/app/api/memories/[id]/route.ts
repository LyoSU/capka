import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { MEMORY_TYPES } from "@/lib/constants";
import { requireOwned } from "@/lib/db/ownership";

export const PUT = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  const existing = await requireOwned(memories, id, userId, "Memory");

  const body = await req.json();
  const updates: Record<string, string> = {};
  if (body.content && typeof body.content === "string") updates.content = body.content.trim();
  if (body.type && MEMORY_TYPES.includes(body.type)) updates.type = body.type;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  await db.update(memories).set(updates).where(and(eq(memories.id, id), eq(memories.userId, userId)));
  return Response.json({ ...existing, ...updates });
});

export const DELETE = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(memories, id, userId, "Memory");

  await db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
  return new Response(null, { status: 204 });
});
