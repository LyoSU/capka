import { apiHandler, requireSession } from "@/lib/auth";
import { membersCanInstallPlugins } from "@/lib/settings";
import { getCatalog, listMarketplaces } from "@/lib/marketplace/service";

/** Read-only browse over the admin-connected marketplaces, for installing. Open to
 *  admins, and to members when the admin allows member installs. No `marketplaceId`
 *  → the marketplace list; with one → that marketplace's catalog (installed flags
 *  scoped to the viewer). */
export const GET = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  if (role !== "admin" && !(await membersCanInstallPlugins())) {
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }
  const marketplaceId = new URL(req.url).searchParams.get("marketplaceId");
  if (marketplaceId) return Response.json({ items: await getCatalog(marketplaceId, userId) });
  return Response.json({ marketplaces: await listMarketplaces() });
});
