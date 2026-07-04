import { apiHandler, requireActive } from "@/lib/auth";
import { pcFolderLevel, canAttachPc } from "@/lib/manage/controls/folders";

// Whether THIS user may connect a folder from their own computer, so the composer
// can show or hide the affordance without leaking the setting to the client.
// "everyone" for anyone, "admins" for admins only, "off" for no one. (Server
// folders are a separate, admin-only, chat-driven path.)
export const GET = apiHandler(async () => {
  const { role } = await requireActive();
  const level = await pcFolderLevel();
  return Response.json({ level, canAttach: canAttachPc(level, role === "admin") });
});
