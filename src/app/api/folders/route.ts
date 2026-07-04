import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachedFolders, chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";
import { pcFolderLevel, canAttachPc } from "@/lib/manage/controls/folders";
import { sanitizeFolderName } from "@/lib/folder-bridge/filter";

/** The sandbox session key for a chat the caller owns (`projectId ?? chatId`),
 *  resolved server-side — never trusted from the client. Throws (→ 404) via
 *  requireOwned if the chat isn't the caller's. */
async function ownedSessionKey(chatId: string, userId: string): Promise<string> {
  const chat = await requireOwned(chats, chatId, userId, "Chat");
  return workspaceSessionKey({ id: chatId, projectId: (chat.projectId as string | null) ?? null });
}

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });
  const key = await ownedSessionKey(chatId, userId);
  const rows = await db.select().from(attachedFolders).where(eq(attachedFolders.sessionKey, key));
  return Response.json({ folders: rows.map((f) => ({ id: f.id, kind: f.kind, name: f.name, readOnly: f.readOnly })) });
});

// Attach a PC folder (kind "pc") after the browser has picked it. Server (host)
// folders are attached only through the `manage` tool, never this route.
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireActive();
  // pc folders: "everyone" lets any user connect their own; "admins" needs admin;
  // "off" attaches nothing. (Server folders are admin-only and go through manage.)
  if (!canAttachPc(await pcFolderLevel(), role === "admin")) {
    return Response.json({ error: "Personal folder access is disabled." }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { chatId?: unknown; name?: unknown };
  const chatId = typeof body.chatId === "string" ? body.chatId : null;
  if (!chatId) return Response.json({ error: "Missing chatId" }, { status: 400 });
  const name = sanitizeFolderName(typeof body.name === "string" ? body.name : "");
  if (!name) return Response.json({ error: "Invalid folder name" }, { status: 400 });

  const key = await ownedSessionKey(chatId, userId);
  const existing = await db.select({ name: attachedFolders.name }).from(attachedFolders).where(eq(attachedFolders.sessionKey, key));
  if (existing.some((r) => r.name === name)) {
    return Response.json({ error: "A folder with that name is already attached." }, { status: 409 });
  }
  const id = randomUUID();
  await db.insert(attachedFolders).values({ id, userId, sessionKey: key, kind: "pc", name, hostPath: null, readOnly: false });
  return Response.json({ folder: { id, kind: "pc", name, readOnly: false } }, { status: 201 });
});
