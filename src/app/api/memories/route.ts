import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { MEMORY_TYPES } from "@/lib/constants";

const createMemorySchema = z.object({
  content: z.string().min(1, "content is required"),
  type: z.enum(MEMORY_TYPES).default("fact"),
  projectId: z.string().optional(),
});

export const GET = apiHandler(async (req: Request) => {
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
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { content, type, projectId } = createMemorySchema.parse(await req.json());

  const memory = {
    id: nanoid(),
    userId,
    content: content.trim(),
    type,
    projectId: projectId || null,
  };

  await db.insert(memories).values(memory);
  return Response.json(memory, { status: 201 });
});
