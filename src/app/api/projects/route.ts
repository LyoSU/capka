import { eq, and, sql, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, chats } from "@/lib/db/schema";
import { projectCreateSchema } from "@/lib/projects/schema";
import { projectNotDeleted } from "@/lib/projects/live";

export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  // chatCount and lastChatAt are computed as separate correlated subqueries, NOT a
  // join+group-by — joining chats (one-to-many) alongside any other one-to-many
  // (skills, connectors) would multiply the counts. Only non-archived chats count.
  // Sorted by recency of activity, falling back to createdAt so a brand-new empty
  // project still shows up top (the sidebar section relies on this ordering).
  const chatCount = sql<number>`(select count(*)::int from ${chats} where ${chats.projectId} = ${projects.id} and ${chats.archived} = false)`;
  const lastChatAt = sql<Date | null>`(select max(${chats.updatedAt}) from ${chats} where ${chats.projectId} = ${projects.id} and ${chats.archived} = false)`;
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      systemPrompt: projects.systemPrompt,
      defaultModel: projects.defaultModel,
      sandboxNetwork: projects.sandboxNetwork,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      chatCount,
      lastChatAt,
    })
    .from(projects)
    .where(and(eq(projects.userId, userId), projectNotDeleted))
    .orderBy(desc(sql`coalesce(${lastChatAt}, ${projects.createdAt})`));

  return Response.json(rows);
});

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { name, description, systemPrompt, defaultModel, sandboxNetwork } = projectCreateSchema.parse(await req.json());

  const id = nanoid();
  const [project] = await db
    .insert(projects)
    .values({
      id,
      userId,
      name,
      description: description?.trim() || null,
      systemPrompt: systemPrompt?.trim() || null,
      defaultModel: defaultModel?.trim() || null,
      sandboxNetwork,
    })
    .returning();

  return Response.json(project, { status: 201 });
});
