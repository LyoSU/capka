import { eq, and } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats } from "@/lib/db/schema";

async function findProject(id: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .limit(1);
  return project;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  const project = await findProject(id, userId);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(project);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  const existing = await findProject(id, userId);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

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
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await requireSession();
  const { id } = await params;
  const existing = await findProject(id, userId);
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  await db.update(chats).set({ projectId: null }).where(and(eq(chats.projectId, id), eq(chats.userId, userId)));
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));

  return new Response(null, { status: 204 });
}
