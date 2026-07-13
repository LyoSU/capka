import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";
import { pcFolderLevel, canAttachPc } from "@/lib/manage/controls/folders";
import { sanitizeFolderName } from "@/lib/folder-bridge/filter";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const { searchParams } = new URL(req.url);
  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const rows = await db.select().from(attachedFolders).where(eq(attachedFolders.sessionKey, sessionKey));
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
  const body = (await req.json().catch(() => ({}))) as { chatId?: unknown; projectId?: unknown; name?: unknown };
  const chatId = typeof body.chatId === "string" ? body.chatId : null;
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const name = sanitizeFolderName(typeof body.name === "string" ? body.name : "");
  if (!name) return Response.json({ error: "Invalid folder name" }, { status: 400 });

  const { sessionKey } = await resolveWorkspaceTarget({ userId, chatId, projectId });
  const existing = await db.select({ name: attachedFolders.name }).from(attachedFolders).where(eq(attachedFolders.sessionKey, sessionKey));
  if (existing.some((r) => r.name === name)) {
    return Response.json({ error: "A folder with that name is already attached." }, { status: 409 });
  }
  const id = randomUUID();
  await db.insert(attachedFolders).values({ id, userId, sessionKey, kind: "pc", name, hostPath: null, readOnly: false });
  return Response.json({ folder: { id, kind: "pc", name, readOnly: false } }, { status: 201 });
});
