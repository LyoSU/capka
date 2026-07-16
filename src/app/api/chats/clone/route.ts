import { requireRole, apiHandler } from "@/lib/auth";
import { cloneSharedChat } from "@/lib/chat/tree";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// POST /api/chats/clone { token }
//
// Take a publicly shared conversation into the signed-in user's own account as
// a fresh, private, continuable chat. Mirrors fork, but crosses ownership — so
// the heavy lifting (and the "is this chat actually shared?" gate) lives in
// cloneSharedChat, which refuses anything that isn't published.
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const limited = guardRateLimit(
    `chat-copy:${userId}`,
    RATE_LIMITS.chatCopy,
    "Too many chat copies — please wait before trying again.",
  );
  if (limited) return limited;
  const { token } = (await req.json()) as { token?: string };
  if (!token) return Response.json({ error: "Missing token" }, { status: 400 });

  const newChatId = await cloneSharedChat({ token, userId });
  if (!newChatId) return Response.json({ error: "Chat not found or not shared" }, { status: 404 });
  return Response.json({ id: newChatId }, { status: 201 });
});
