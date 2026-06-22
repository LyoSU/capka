import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { isShared, generateShareToken } from "@/lib/chat/sharing";

export const PATCH = apiHandler(async (req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  const existing = await requireOwned(chats, id, userId, "Chat");

  const body = await req.json();
  // Re-pointing a chat at a project must verify the caller owns that project —
  // otherwise the reference integrity breaks (even though the runner re-resolves
  // project scope by userId at run time).
  if (body.projectId) await requireOwned(projects, body.projectId, userId, "Project");

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
