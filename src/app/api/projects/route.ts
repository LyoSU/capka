import { eq, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  defaultModel: z.string().optional(),
  sandboxNetwork: z.enum(["bridge", "none"]).default("none"),
});

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));

  return Response.json(rows);
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { name, description, systemPrompt, defaultModel, sandboxNetwork } = createProjectSchema.parse(await req.json());

  const id = nanoid();
  const [project] = await db
    .insert(projects)
    .values({
      id,
      userId,
      name: name.trim(),
      description: description?.trim() || null,
      systemPrompt: systemPrompt?.trim() || null,
      defaultModel: defaultModel?.trim() || null,
      sandboxNetwork,
    })
    .returning();

  return Response.json(project, { status: 201 });
});
