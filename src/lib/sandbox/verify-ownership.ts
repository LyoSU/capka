import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { ApiError } from "@/lib/auth";

/** Verify the user owns the chat. Throws 404 if chat doesn't exist or belongs to another user. */
export async function verifyChatOwnership(chatId: string, userId: string) {
  const [chat] = await db
    .select({ id: chats.id, userId: chats.userId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat || chat.userId !== userId) throw new ApiError("Chat not found", 404);
}
