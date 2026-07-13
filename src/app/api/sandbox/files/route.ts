import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { listFiles, deleteFile } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path") || ".";
  // Depth of the listing (default 1 = a single level, the file browser's view).
  // The folder-sync bridge asks for a deep tree so nested files under a synced
  // folder are seen (and pulled) — without this the route dropped `depth` and only
  // top-level entries came back, so a subfolder appeared but its files never did.
  const depthRaw = parseInt(searchParams.get("depth") || "1", 10);
  const depth = Number.isFinite(depthRaw) ? depthRaw : 1;
  // Folder sync passes a high limit so it gets a COMPLETE tree (a truncated one
  // reads as server-side deletes and would drive a destructive local delete).
  const limitRaw = parseInt(searchParams.get("limit") || "0", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  // Browse a chat's or a project's shared workspace (exactly one target), resolved
  // + ownership-checked server-side — read from the host fs, no running container.
  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const data = await listFiles(sessionKey, path, userId, depth, limit);
  return Response.json(data);
});

// Remove one file from a workspace — used when the user detaches a staged
// attachment from the composer (eager upload already put it in the sandbox), or
// deletes a file from the hub's file browser.
export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path");
  if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const data = await deleteFile(sessionKey, path, userId);
  return Response.json(data);
});
