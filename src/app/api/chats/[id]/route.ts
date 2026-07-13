import { eq, and, inArray, sql } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, tasks } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { NotFoundError } from "@/lib/errors";
import { isShared, generateShareToken } from "@/lib/chat/sharing";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { listFiles, copyWorkspace } from "@/lib/sandbox/client";
import { isLiveProject } from "@/lib/projects/live";
import { log } from "@/lib/log";

export const PATCH = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  const existing = await requireOwned(chats, id, userId, "Chat");

  const body = await req.json();
  const oldProjectId = (existing.projectId as string | null) ?? null;
  // A "projectId" key present in the body is a move (to a project, or to null =
  // "remove from project"). Distinguish "absent" (no move) from "null" (unassign).
  const movingProject = Object.prototype.hasOwnProperty.call(body, "projectId");
  const newProjectId = movingProject ? ((body.projectId as string | null) ?? null) : undefined;

  if (movingProject && newProjectId !== oldProjectId) {
    // The target project must be the caller's and still live (not tombstoned).
    if (newProjectId && !(await isLiveProject(newProjectId, userId))) {
      throw new NotFoundError("Project");
    }

    // Precondition: a move relocates the workspace, so refuse while a turn is live
    // for this chat — a mid-flight write would land in the wrong workspace.
    const [active] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.chatId, id), inArray(tasks.status, ["queued", "running"])));
    if (active && active.n > 0) {
      return Response.json({ error: "This chat is still working — wait for the reply to finish.", code: "TASK_RUNNING" }, { status: 409 });
    }

    // Chat WITHOUT a project → a project: the chat's own scratch files are carried
    // into the project's shared workspace under a stable, deterministic subdir, so a
    // retry after a failed switch replaces (not duplicates) the copy. Moving between
    // projects (or to none) does NOT copy: a project's files are shared by all its
    // chats and stay put; "→ none" gets a fresh empty workspace under the chat id.
    if (!oldProjectId && newProjectId) {
      const srcKey = workspaceSessionKey({ id, projectId: null });
      // No catch: a failed listing must ABORT the move (surfacing as a friendly
      // SandboxError, same as a copy failure) — never be read as "no files" and
      // silently skip the carry-over while still switching projectId.
      const listing = await listFiles(srcKey, ".", userId);
      const hasFiles = (listing.entries ?? []).some((e) => !e.name.startsWith("."));
      if (hasFiles) {
        const title = ((existing.title as string | null) || "chat").replace(/[/\\]/g, "-").slice(0, 80);
        const subdir = `Із чату «${title}» (${id.slice(0, 8)})`;
        await copyWorkspace(newProjectId, srcKey, subdir, userId);
        log.info("chat files carried into project on move", { chatId: id, projectId: newProjectId });
      }
    }
  }

  const allowed = ["title", "pinned", "archived", "projectId"] as const;
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }
  // A content/organization edit counts as activity and bumps `updatedAt`, which
  // reorders the sidebar. A visibility-only change must NOT: bumping it would
  // jump the chat into the "today" group, remounting its sidebar row and slamming
  // the still-open share dialog shut. So only touch `updatedAt` for real edits.
  if (Object.keys(updates).length > 0) updates.updatedAt = new Date();

  // Publish / unpublish. Validate the visibility, and mint a stable share token
  // the first time the chat is ever shared — unpublishing keeps it so the same
  // URL reactivates if re-shared later.
  let shareToken = (existing.shareToken as string | null) ?? null;
  if ("visibility" in body) {
    const v = body.visibility;
    if (v !== "private" && v !== "link" && v !== "users") {
      return Response.json({ error: "Invalid visibility" }, { status: 400 });
    }
    updates.visibility = v;
    if (isShared(v) && !shareToken) {
      shareToken = generateShareToken();
      updates.shareToken = shareToken;
    }
  }

  // Nothing recognized to change — skip the write (an empty `.set({})` throws in
  // drizzle). Previously `updatedAt` always filled `updates`, so this is new.
  if (Object.keys(updates).length > 0) {
    await db.update(chats).set(updates).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  }
  return Response.json({
    ok: true,
    visibility: updates.visibility ?? existing.visibility,
    shareToken,
  });
});

export const DELETE = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(chats, id, userId, "Chat");

  await db.delete(chats).where(and(eq(chats.id, id), eq(chats.userId, userId)));
  return new Response(null, { status: 204 });
});
