import { requireRole, apiHandler } from "@/lib/auth";
import { createSession, uploadFile } from "@/lib/sandbox/client";
import { verifyChatOwnership } from "@/lib/sandbox/verify-ownership";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const formData = await req.formData();
  const chatId = formData.get("chatId") as string;
  const path = (formData.get("path") as string) || ".";
  const file = formData.get("file") as File;

  if (!chatId || !file) return Response.json({ error: "Missing chatId or file" }, { status: 400 });

  await verifyChatOwnership(chatId, userId);
  await createSession(chatId, userId);
  const result = await uploadFile(chatId, path, file);
  return Response.json(result);
});
