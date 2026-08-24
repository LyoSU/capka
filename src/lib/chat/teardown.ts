import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chats, attachedFolders } from "@/lib/db/schema";
import { destroySession } from "@/lib/sandbox/client";
import { log } from "@/lib/log";

/** Delete a chat AND the state it owns outside its own row.
 *
 *  The row delete lives here rather than in the route because a chat owns more
 *  than itself: a sandbox session and a set of folder attachments, neither of
 *  which any FK reaches. `attached_folders` is keyed by the plain string
 *  `sessionKey` (no chat FK), so a bare `db.delete(chats)` left those rows
 *  unreachable forever — nothing lists them, nothing reaps them, and the unique
 *  index on (session_key, name) keeps them occupying the name.
 *
 *  Only a chat with NO project owns anything: `workspaceSessionKey` is
 *  `projectId ?? chatId`, so every chat inside a project shares the PROJECT's
 *  workspace and folder attachments. Tearing those down when one member chat is
 *  deleted would wipe the project's files and detach folders its siblings still
 *  use — so a project member deletes its row and nothing else.
 *
 *  Sandbox destroy is best-effort: the controller's TTL reaper already removes an
 *  unused workspace, so a controller blip must not fail the user's delete. The
 *  folder rows are NOT best-effort — they are the part with no backstop. */
export async function deleteChat(chat: { id: string; userId: string; projectId: string | null }): Promise<void> {
  if (!chat.projectId) {
    // Chat-owned sandbox: kill the container and wipe its workspace directory.
    await destroySession(chat.id, chat.userId).catch((e) => {
      log.warn("chat sandbox teardown failed; TTL reaper will collect it", { chatId: chat.id, err: String(e) });
    });
    // Detach its folders — the attachment rows only. The originals on the host or
    // the user's own computer are never touched.
    await db.delete(attachedFolders).where(eq(attachedFolders.sessionKey, chat.id));
  }
  await db.delete(chats).where(and(eq(chats.id, chat.id), eq(chats.userId, chat.userId)));
}
