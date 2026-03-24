import { eq, and } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";

async function findChat(id: string, userId: string) {
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1);
  return chat;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  if (!await findChat(id, userId)) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const allowed = ["title", "pinned", "archived", "projectId"] as const;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  await db.update(chats).set(updates).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  if (!await findChat(id, userId)) return Response.json({ error: "Not found" }, { status: 404 });

  await db.delete(chats).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  return new Response(null, { status: 204 });
}
