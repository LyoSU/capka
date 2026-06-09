import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

export const PATCH = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(chats, id, userId, "Chat");

  const body = await req.json();
  // Re-pointing a chat at a project must verify the caller owns that project —
  // otherwise the reference integrity breaks (even though the runner re-resolves
  // project scope by userId at run time).
  if (body.projectId) await requireOwned(projects, body.projectId, userId, "Project");

  const allowed = ["title", "pinned", "archived", "projectId"] as const;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  await db.update(chats).set(updates).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  return Response.json({ ok: true });
});

export const DELETE = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(chats, id, userId, "Chat");

  await db.delete(chats).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  return new Response(null, { status: 204 });
});
