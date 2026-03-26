import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/errors";

/** Verify the user owns the chat. Throws 404 if chat doesn't exist or belongs to another user. */
export async function verifyChatOwnership(chatId: string, userId: string) {
  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);
  if (!chat) throw new NotFoundError("Chat");
}
