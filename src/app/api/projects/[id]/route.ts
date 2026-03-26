import { eq, and } from "drizzle-orm";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

export const GET = apiHandler(async (_req, { params }) => {
  const { userId } = await requireSession();
  const { id } = await params;
  const project = await requireOwned(projects, id, userId, "Project");
  return Response.json(project);
});

export const PUT = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(projects, id, userId, "Project");

  const body = await req.json();
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.systemPrompt !== undefined) updates.systemPrompt = body.systemPrompt?.trim() || null;
  if (body.defaultModel !== undefined) updates.defaultModel = body.defaultModel?.trim() || null;
  if (body.sandboxNetwork !== undefined) updates.sandboxNetwork = body.sandboxNetwork === "bridge" ? "bridge" : "none";

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .returning();

  return Response.json(updated);
});

export const DELETE = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(projects, id, userId, "Project");

  await db.update(chats).set({ projectId: null }).where(and(eq(chats.projectId, id), eq(chats.userId, userId)));
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));

  return new Response(null, { status: 204 });
});
