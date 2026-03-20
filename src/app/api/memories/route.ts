import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";

import { MEMORY_TYPES } from "@/lib/constants";

export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const type = searchParams.get("type");

  const conditions = [eq(memories.userId, userId)];
  if (projectId) conditions.push(eq(memories.projectId, projectId));
  if (type) conditions.push(eq(memories.type, type));

  const rows = await db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.createdAt))
    .limit(200);

  return Response.json(rows);
}

export async function POST(req: Request) {
  const { userId } = await requireSession();
  const body = await req.json();
  const { content, type = "fact", projectId } = body;

  if (!content || typeof content !== "string") {
    return Response.json({ error: "content is required" }, { status: 400 });
  }
  if (!MEMORY_TYPES.includes(type)) {
    return Response.json({ error: "type must be fact, preference, or context" }, { status: 400 });
  }

  const memory = {
    id: nanoid(),
    userId,
    content: content.trim(),
    type,
    projectId: projectId || null,
  };

  await db.insert(memories).values(memory);
  return Response.json(memory, { status: 201 });
}
