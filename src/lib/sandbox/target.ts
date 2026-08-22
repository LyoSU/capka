import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats, projects } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { projectNotDeleted } from "@/lib/projects/live";
import { workspaceSessionKey } from "./workspace";

// The client-facing WorkspaceTarget shape (a chat- or project-addressed workspace)
// lives in @/lib/workspace-target (isomorphic). This module is the server-side
// resolver that turns the two ids into a sandbox session key.

export type ResolvedTarget = { sessionKey: string; projectId: string | null; ownerId: string };

/** The one resolver every `/api/sandbox/files*` and `/api/folders*` route uses to
 *  turn a request into a sandbox session key. Requires EXACTLY one of chatId /
 *  projectId (both or neither → 400), checks ownership (`requireOwned`, and for a
 *  project also `deleted_at is null` so a tombstoned project resolves to 404), and
 *  never trusts a sessionKey supplied by the caller. */
export async function resolveWorkspaceTarget({
  userId,
  chatId,
  projectId,
}: {
  userId: string;
  chatId?: string | null;
  projectId?: string | null;
}): Promise<ResolvedTarget> {
  const hasChat = typeof chatId === "string" && chatId.length > 0;
  const hasProject = typeof projectId === "string" && projectId.length > 0;
  if (hasChat === hasProject) {
    throw new ValidationError("Provide exactly one of chatId or projectId.");
  }

  if (hasProject) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId!), eq(projects.userId, userId), projectNotDeleted))
      .limit(1);
    if (!project) throw new NotFoundError("Project");
    // A project's workspace is keyed by the project id itself (workspaceSessionKey).
    return { sessionKey: project.id, projectId: project.id, ownerId: userId };
  }

  const chat = await requireOwned(chats, chatId!, userId, "Chat");
  const chatProjectId = (chat.projectId as string | null) ?? null;
  return {
    sessionKey: workspaceSessionKey({ id: chatId!, projectId: chatProjectId }),
    projectId: chatProjectId,
    ownerId: userId,
  };
}

/** The human name of the workspace a target points at, for naming a download.
 *
 *  Branches on the workspace ACTUALLY being served, not on what the client asked
 *  for: a chat inside a project shares the PROJECT's workspace
 *  (`workspaceSessionKey` is `projectId ?? chatId`), so an archive downloaded from
 *  such a chat contains every chat's files and must be named after the project.
 *  Naming it after the chat would promise one conversation and deliver all of them.
 *
 *  Ownership is already enforced by `resolveWorkspaceTarget`, which must run first
 *  to produce the `ResolvedTarget` this takes — but the owner is re-asserted in both
 *  queries anyway, so a future caller passing a hand-built target cannot read a name
 *  across accounts. Returns null when the row has no name (an untitled chat) — the
 *  caller supplies a localized fallback. */
export async function workspaceLabel(target: ResolvedTarget): Promise<string | null> {
  if (target.projectId) {
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, target.projectId), eq(projects.userId, target.ownerId)))
      .limit(1);
    return project?.name ?? null;
  }
  // No project, so the session key IS the chat id (see workspaceSessionKey).
  const [chat] = await db
    .select({ title: chats.title })
    .from(chats)
    .where(and(eq(chats.id, target.sessionKey), eq(chats.userId, target.ownerId)))
    .limit(1);
  return chat?.title ?? null;
}

/** Read a target from a request's query params (chatId / projectId). A tiny helper
 *  so every route parses the pair identically. */
export function targetParamsFrom(searchParams: URLSearchParams): { chatId: string | null; projectId: string | null } {
  return { chatId: searchParams.get("chatId"), projectId: searchParams.get("projectId") };
}
