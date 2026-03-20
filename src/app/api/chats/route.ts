import { NextRequest, NextResponse } from "next/server";
import { eq, desc, and, ilike, isNull, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  const { userId } = await requireSession();
  const params = req.nextUrl.searchParams;
  const search = params.get("search");
  const archived = params.get("archived");
  const pinned = params.get("pinned");
  const projectId = params.get("projectId");

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

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const { userId } = await requireSession();
  const body = await req.json();

  await db.insert(chats).values({
    id: body.id || nanoid(),
    userId,
    title: body.title || "New Chat",
    model: body.model,
    projectId: body.projectId,
  });

  return NextResponse.json({ id: body.id }, { status: 201 });
}
