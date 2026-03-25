import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";

/** Verify the user owns the chat. Returns true if authorized, throws 404 otherwise. */
export async function verifyChatOwnership(chatId: string, userId: string) {
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) throw Response.json({ error: "Chat not found" }, { status: 404 });
}
