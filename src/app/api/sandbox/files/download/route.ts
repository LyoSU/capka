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
  // Quick Look fetches the same bytes but renders them in-page. `inline` flips
  // the disposition so the browser displays instead of saving.
  const inline = searchParams.get("inline") === "1";

  if (!chatId || !filePath) return Response.json({ error: "Missing chatId or path" }, { status: 400 });

  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
  const controllerRes = await downloadFile(key, filePath, userId);

  // Proxy the binary stream from controller to client
  const filename = filePath.split("/").pop() || "file";
  const safeFilename = filename.replace(/[^\x20-\x7E]/g, "_"); // ASCII-safe fallback
  const encodedFilename = encodeURIComponent(filename);

  const disposition = inline
    ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
    : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;

  const headers: Record<string, string> = {
    "Content-Type": controllerRes.headers.get("Content-Type") || "application/octet-stream",
    "Content-Length": controllerRes.headers.get("Content-Length") || "",
    "Content-Disposition": disposition,
    // Sandbox files are user/AI-supplied; never let the browser MIME-sniff them.
    "X-Content-Type-Options": "nosniff",
  };
  // Inline content renders from our own origin — lock it down so a malicious
  // file (e.g. an SVG/HTML opened directly) can't execute against the app.
  // `default-src 'none'` neuters scripts; `frame-ancestors 'self'` allows only
  // our own Quick Look iframe. No `sandbox` token — it can break the browser's
  // native PDF viewer, and the directives above already contain the risk.
  if (inline) headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'";

  return new Response(controllerRes.body, { headers });
});
