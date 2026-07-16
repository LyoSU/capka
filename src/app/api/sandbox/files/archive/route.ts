import { requireActive, apiHandler } from "@/lib/auth";
import { archiveWorkspace } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// Download the ENTIRE workspace as one gzipped tar, streamed from the controller
// (read off the host directory root — no container, and complete regardless of any
// listing limit). This is the honest "download everything" / "download before
// deleting the project" backup; `download-all` can silently drop files a truncated
// client listing never saw.
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const limited = guardRateLimit(
    `workspace-archive:${userId}`,
    RATE_LIMITS.workspaceArchive,
    "Too many archive requests — please wait before trying again.",
  );
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });

  const controllerRes = await archiveWorkspace(sessionKey, userId);
  const headers: Record<string, string> = {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="workspace.tar.gz"`,
  };
  const contentLength = controllerRes.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  return new Response(controllerRes.body, { headers });
});
