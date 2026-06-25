import { apiHandler, requireActive } from "@/lib/auth";
import { membersCanInstallPlugins } from "@/lib/settings";

/** What the signed-in user may do with plugins: browse/install (admin always;
 *  members only when the admin opted in) and manage marketplaces (admin only). */
export const GET = apiHandler(async () => {
  const { role } = await requireActive();
  const isAdmin = role === "admin";
  const canInstall = isAdmin || (await membersCanInstallPlugins());
  return Response.json({ isAdmin, canInstall });
});
