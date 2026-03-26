import { eq, desc, and, ilike, isNull, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession, requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";

export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");
  const archived = searchParams.get("archived");
  const pinned = searchParams.get("pinned");
  const projectId = searchParams.get("projectId");

  const conditions: SQL[] = [eq(chats.userId, userId)];

  if (search) conditions.push(ilike(chats.title, `%${search}%`));
  if (archived === "true") conditions.push(eq(chats.archived, true));
  else if (archived !== "all") conditions.push(eq(chats.archived, false));
  if (pinned === "true") conditions.push(eq(chats.pinned, true));
  else if (pinned === "false") conditions.push(eq(chats.pinned, false));
  if (projectId === "none") conditions.push(isNull(chats.projectId));
  else if (projectId) conditions.push(eq(chats.projectId, projectId));

  const rows = await db
    .select({
      id: chats.id,
      title: chats.title,
      pinned: chats.pinned,
      archived: chats.archived,
      projectId: chats.projectId,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(and(...conditions))
    .orderBy(desc(chats.pinned), desc(chats.updatedAt))
    .limit(100);

  return Response.json(rows);
}

export async function POST(req: Request) {
  const { userId } = await requireRole("admin", "user");
  const body = await req.json();

  const id = body.id || nanoid();
  await db.insert(chats).values({
    id,
    userId,
    title: body.title || "New Chat",
    model: body.model,
    projectId: body.projectId,
  }).onConflictDoNothing();

  return Response.json({ id }, { status: 201 });
}
