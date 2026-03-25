import { requireSession } from "@/lib/auth";
import { createSession, downloadFile } from "@/lib/sandbox/client";
import { verifyChatOwnership } from "@/lib/sandbox/verify-ownership";

export async function GET(req: Request) {
  try {
    const { userId } = await requireSession();
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get("chatId");
    const filePath = searchParams.get("path");

    if (!chatId || !filePath) return Response.json({ error: "Missing chatId or path" }, { status: 400 });

    await verifyChatOwnership(chatId, userId);
    await createSession(chatId, userId);
    const controllerRes = await downloadFile(chatId, filePath);

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
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("[download]", e);
    return Response.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
