import { requireRole, ApiError } from "@/lib/auth";
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

    // For new chats, the chat row doesn't exist yet (created on first message).
    // Verify ownership only if the chat already exists — otherwise allow upload
    // so files are ready in workspace before the message is sent.
    await verifyChatOwnership(chatId, userId, { allowMissing: true });
    await createSession(chatId, userId);
    const result = await uploadFile(chatId, path, file);
    return Response.json(result);
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse();
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
