import { requireSession, apiHandler } from "@/lib/auth";
import { createSession, execCommand, downloadFile } from "@/lib/sandbox/client";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { chats } from "@/lib/db/schema";

// Only allow safe characters in file paths (matches client-side WORKSPACE_PATH_RE)
const SAFE_PATH_RE = /^[\w/.А-Яа-яІіЇїЄєҐґ_\- ()]+$/;

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  const paths = searchParams.getAll("paths");

  if (!chatId || paths.length === 0) {
    return Response.json({ error: "Missing chatId or paths" }, { status: 400 });
  }
  if (paths.some((p) => !SAFE_PATH_RE.test(p) || p.includes(".."))) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  const chat = await requireOwned(chats, chatId, userId, "Chat");
  const key = workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
  // Archiving shells out to zip/tar, so a live container is required here.
  await createSession(key, userId);

  const shellPaths = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");

  // Try zip, fall back to tar.gz — rm first to avoid stale entries from prior downloads
  let archiveName = ".download.zip";
  let displayName = "workspace-files.zip";
  let contentType = "application/zip";

  const zipResult = await execCommand(key, `cd /workspace && rm -f '${archiveName}' && zip -r '${archiveName}' ${shellPaths}`, 30_000);
  if (zipResult.exitCode !== 0) {
    archiveName = ".download.tar.gz";
    displayName = "workspace-files.tar.gz";
    contentType = "application/gzip";
    const tarResult = await execCommand(key, `cd /workspace && tar -czf '${archiveName}' ${shellPaths}`, 30_000);
    if (tarResult.exitCode !== 0) {
      return Response.json({ error: "Failed to create archive" }, { status: 500 });
    }
  }

  const controllerRes = await downloadFile(key, archiveName, userId);
  return new Response(controllerRes.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": controllerRes.headers.get("Content-Length") || "",
      "Content-Disposition": `attachment; filename="${displayName}"`,
    },
  });
});
