import { requireSession, apiHandler } from "@/lib/auth";
import { createSession, listFiles } from "@/lib/sandbox/client";
import { verifyChatOwnership } from "@/lib/sandbox/verify-ownership";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const path = searchParams.get("path") || ".";

  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });

  await verifyChatOwnership(chatId, userId);
  await createSession(chatId, userId);
  const data = await listFiles(chatId, path);
  return Response.json(data);
});
