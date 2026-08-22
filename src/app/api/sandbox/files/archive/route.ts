import { getTranslations } from "next-intl/server";
import { requireActive, apiHandler } from "@/lib/auth";
import { archiveWorkspace } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom, workspaceLabel } from "@/lib/sandbox/target";
import { guardRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { archiveFilename, contentDisposition } from "@/lib/download-filename";

// Download the ENTIRE workspace as one zip, streamed from the controller (read off
// the host directory root — no container, and complete regardless of any listing
// limit). This is the honest "download everything" / "download before deleting the
// project" backup; `download-all` can silently drop files a truncated client
// listing never saw.
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const limited = guardRateLimit(
    `workspace-archive:${userId}`,
    RATE_LIMITS.workspaceArchive,
    "Too many archive requests — please wait before trying again.",
  );
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const target = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });

  // Named after the workspace and dated, so a Downloads folder holding several of
  // these still says which project each one is — `workspace.zip (3)` did not.
  const t = await getTranslations("chat.workspace");
  const filename = archiveFilename(await workspaceLabel(target), t("archiveFallback"), "zip");

  const controllerRes = await archiveWorkspace(target.sessionKey, userId);
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Content-Disposition": contentDisposition(filename),
  };
  const contentLength = controllerRes.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  return new Response(controllerRes.body, { headers });
});
