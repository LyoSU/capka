import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireActive, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { memoryDocs, projects } from "@/lib/db/schema";
import { projectNotDeleted, requireLiveProject } from "@/lib/projects/live";
import { setMemoryDoc } from "@/lib/memory/store";

// All of a user's memory docs in one shot: the user-global doc plus every
// project's doc (left-joined, so projects with no doc yet come back empty).
export const GET = apiHandler(async () => {
  const { userId } = await requireActive();
  const [userRow] = await db
    .select({ content: memoryDocs.content })
    .from(memoryDocs)
    .where(and(eq(memoryDocs.userId, userId), isNull(memoryDocs.projectId)))
    .limit(1);
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, content: memoryDocs.content })
    .from(projects)
    .leftJoin(memoryDocs, and(eq(memoryDocs.projectId, projects.id), eq(memoryDocs.userId, userId)))
    .where(and(eq(projects.userId, userId), projectNotDeleted))
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
  // Guard cross-user writes to a project's doc — and refuse a tombstoned project.
  if (projectId) await requireLiveProject(projectId, userId);
  await setMemoryDoc(userId, projectId ?? null, content);
  return Response.json({ ok: true });
});
