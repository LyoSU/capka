import { requireSession, apiHandler } from "@/lib/auth";
import { createSession, listFiles } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { chats } from "@/lib/db/schema";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const path = searchParams.get("path") || ".";

  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  await requireOwned(chats, chatId, userId, "Chat");
  await createSession(chatId, userId);
  const data = await listFiles(chatId, path);
  return Response.json(data);
});
