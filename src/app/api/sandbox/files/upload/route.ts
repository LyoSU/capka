import { requireRole, apiHandler } from "@/lib/auth";
import { uploadFile } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { chats } from "@/lib/db/schema";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const formData = await req.formData();
  const chatId = formData.get("chatId") as string;
  const path = (formData.get("path") as string) || ".";
  const file = formData.get("file") as File;

  if (!chatId || !file) return Response.json({ error: "Missing chatId or file" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
  const result = await uploadFile(key, path, file, userId);
  return Response.json(result);
});
