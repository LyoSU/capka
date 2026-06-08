import { requireSession, apiHandler } from "@/lib/auth";
import { downloadFile } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { chats } from "@/lib/db/schema";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const filePath = searchParams.get("path");

  if (!chatId || !filePath) return Response.json({ error: "Missing chatId or path" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
  const controllerRes = await downloadFile(key, filePath, userId);

  // Proxy the binary stream from controller to client
  const filename = filePath.split("/").pop() || "file";
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, "_"); // ASCII-safe fallback
  const encodedFilename = encodeURIComponent(filename);

  return new Response(controllerRes.body, {
    headers: {
      "Content-Type": controllerRes.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": controllerRes.headers.get("Content-Length") || "",
      "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
    },
  });
});
