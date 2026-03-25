import { requireRole } from "@/lib/auth";
import { createSession, uploadFile } from "@/lib/sandbox/client";
import { verifyChatOwnership } from "@/lib/sandbox/verify-ownership";

export async function POST(req: Request) {
  try {
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
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
