import { and, eq, gte } from "drizzle-orm";
import { requireSession, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { messages, chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

// DELETE /api/chat/messages?chatId=X&fromId=Y
//
// Truncates a conversation: removes message Y and everything created after it.
// This backs "regenerate" (drop the last reply, re-run) and "edit" (drop a user
// message and its aftermath, then re-ask). Deleting by createdAt — rather than
// id — is what lets us drop "this and everything later" in one statement.
export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const fromId = searchParams.get("fromId");
  if (!chatId || !fromId) {
    return Response.json({ error: "Missing chatId or fromId" }, { status: 400 });
  }

  // 404s if the chat doesn't exist or belongs to another user (IDOR guard).
  await requireOwned(chats, chatId, userId, "Chat");

  const anchor = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.id, fromId), eq(messages.chatId, chatId)))
    .limit(1)
    .then((r) => r[0]);
  if (!anchor?.createdAt) {
    return Response.json({ error: "Message not found" }, { status: 404 });
  }

  await db
    .delete(messages)
    .where(and(eq(messages.chatId, chatId), gte(messages.createdAt, anchor.createdAt)));

  return Response.json({ ok: true });
});
