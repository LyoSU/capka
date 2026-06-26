import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memoryDocs, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { setMemoryDoc } from "@/lib/memory/store";

// All of a user's memory docs in one shot: the user-global doc plus every
// project's doc (left-joined, so projects with no doc yet come back empty).
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  const [userRow] = await db
    .select({ content: memoryDocs.content })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.userId, userId), isNull(memoryDocs.projectId)))
    .limit(1);
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, content: memoryDocs.content })
    .from(projects)
    .leftJoin(memoryDocs, and(eq(memoryDocs.projectId, projects.id), eq(memoryDocs.userId, userId)))
    .where(eq(projects.userId, userId))
    .orderBy(projects.name);

  return Response.json({
    user: userRow?.content ?? "",
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, content: p.content ?? "" })),
  });
});

const putSchema = z.object({
  content: z.string(),
  projectId: z.string().nullable().optional(),
});

export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { content, projectId } = putSchema.parse(await req.json());
  // Guard cross-user writes to a project's doc.
  if (projectId) await requireOwned(projects, projectId, userId, "Project");
  await setMemoryDoc(userId, projectId ?? null, content);
  return Response.json({ ok: true });
});
