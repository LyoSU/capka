import { eq, and, desc } from "drizzle-orm";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";

/** GET /api/tasks?chatId=X — returns the latest task for a chat (used on reconnect) */
export async function GET(req: Request) {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.chatId, chatId), eq(tasks.userId, userId)))
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  return Response.json(task ?? null);
}
