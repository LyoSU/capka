import { requireSession, apiHandler } from "@/lib/auth";
import { listFiles } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { chats } from "@/lib/db/schema";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const path = searchParams.get("path") || ".";

  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  // Browse the chat's project folder (shared) or its own — read from host fs,
  // no running container required.
  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
  const data = await listFiles(key, path, userId);
  return Response.json(data);
});
