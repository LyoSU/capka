import { requireSession, requireRole, apiHandler } from "@/lib/auth";
import { listSharedFiles, deleteSharedFile } from "@/lib/sandbox/client";

// The per-user shared store (`/shared` in every sandbox). It is NOT addressed
// through `resolveWorkspaceTarget`: that resolver maps a chat or project id to a
// session key, and the controller reserves `_global` so it can never arrive as
// one. Here the owner is simply the signed-in user, so there is nothing to
// resolve and no id to trust — which is also why this needed its own route
// rather than a flag on the workspace one.
//
// Until this existed, `/shared` was reachable by the agent (its prompt names the
// folder and invites reusable files into it) and by nobody else: no listing, no
// delete, and no reaper. Files went in and could never come out.

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path") || ".";
  const depthRaw = parseInt(searchParams.get("depth") || "1", 10);
  const depth = Number.isFinite(depthRaw) ? depthRaw : 1;
  const limitRaw = parseInt(searchParams.get("limit") || "0", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const data = await listSharedFiles(userId, path, depth, limit);
  return Response.json(data);
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireRole("admin", "user");
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path");
  if (!path) return Response.json({ error: "Missing path" }, { status: 400 });

  const data = await deleteSharedFile(userId, path);
  return Response.json(data);
});
