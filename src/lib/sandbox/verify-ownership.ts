import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { ApiError } from "@/lib/auth";

/**
 * Verify the user owns the chat.
 * @param opts.allowMissing — if true, skip check when chat doesn't exist yet (new chat upload flow)
 */
export async function verifyChatOwnership(chatId: string, userId: string, opts?: { allowMissing?: boolean }) {
  const [chat] = await db
    .select({ id: chats.id, userId: chats.userId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) {
    if (opts?.allowMissing) return;
    throw new ApiError("Chat not found", 404);
  }
  if (chat.userId !== userId) throw new ApiError("Chat not found", 404);
}
