import { requireSession, apiHandler } from "@/lib/auth";
import { createSession, execCommand, downloadFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";
import { sessionMounts, resolveNetwork } from "@/lib/manage/controls/folders";

// Only allow safe characters in file paths (matches client-side WORKSPACE_PATH_RE)
const SAFE_PATH_RE = /^[\w/.А-Яа-яІіЇїЄєҐґ_\- ()]+$/;

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const paths = searchParams.getAll("paths");

  if (paths.length === 0) {
    return Response.json({ error: "Missing paths" }, { status: 400 });
  }
  if (paths.some((p) => !SAFE_PATH_RE.test(p) || p.includes(".."))) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  const { sessionKey: key, projectId } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  // Archiving shells out to zip/tar, so a live container is required here. Pass
  // the session's real mounts + network so an existing container with host folders
  // is REUSED — omitting them reads as mount drift and would destroy (and reset the
  // network of) a container the agent may be mid-command in on every zip download.
  await createSession(key, userId, await resolveNetwork(projectId), await sessionMounts(key));

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
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${displayName}"`,
  };
  // Forward Content-Length only when present; "" is an invalid header the proxy
  // turns into a 502 (the controller streams the archive chunked).
  const contentLength = controllerRes.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  return new Response(controllerRes.body, { headers });
});
