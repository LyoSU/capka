import { requireRole, apiHandler } from "@/lib/auth";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { forkChat } from "@/lib/chat/tree";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// POST /api/chats/fork { chatId, fromMessageId }
//
// Branch a conversation into a new chat that copies everything from the root
// down to the chosen message, then continues independently — the standard
// agentic move of exploring an alternative path without disturbing the original.
// The new chat lives in the same project, so it shares the same workspace.
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const limited = guardRateLimit(
    `chat-copy:${userId}`,
    RATE_LIMITS.chatCopy,
    "Too many chat copies — please wait before trying again.",
  );
  if (limited) return limited;
  const { chatId, fromMessageId } = (await req.json()) as { chatId?: string; fromMessageId?: string };
  if (!chatId || !fromMessageId) {
    return Response.json({ error: "Missing chatId or fromMessageId" }, { status: 400 });
  }

  await requireOwned(chats, chatId, userId, "Chat");

  const newChatId = await forkChat({ sourceChatId: chatId, fromMessageId, userId });
  if (!newChatId) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({ id: newChatId }, { status: 201 });
});
