import { eq, and } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { MEMORY_TYPES } from "@/lib/constants";

async function findMemory(id: string, userId: string) {
  const [memory] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, userId)))
    .limit(1);
  return memory;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  const existing = await findMemory(id, userId);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const updates: Record<string, string> = {};
  if (body.content && typeof body.content === "string") updates.content = body.content.trim();
  if (body.type && MEMORY_TYPES.includes(body.type)) updates.type = body.type;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  await db.update(memories).set(updates).where(and(eq(memories.id, id), eq(memories.userId, userId)));
  return Response.json({ ...existing, ...updates });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  const existing = await findMemory(id, userId);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  await db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
  return new Response(null, { status: 204 });
}
