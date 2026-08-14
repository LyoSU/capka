import { apiHandler, requireAdmin } from "@/lib/auth";
import { uninstallPlugin } from "@/lib/marketplace/install";
import { findInstall } from "@/lib/marketplace/service";
import { audit } from "@/lib/governance/audit";
/**
 * GONE ON PURPOSE — see /api/extensions/review.
 *
 * An admin install skipped the consent gate entirely: it wrote connectors, skills and
 * executable bundled files with no review and no hash. Being an admin is authorization to
 * install, not evidence of having read what the plugin reaches.
 */
export const POST = apiHandler(async () => {
  await requireAdmin();
  return Response.json(
    { error: "Installs now go through the install review. Use GET /api/extensions/review, then POST it back with the reviewHash." },
    { status: 410 },
  );
});

// NOTE: no PATCH/upgrade here on purpose. Upgrades must go through the review flow
// (GET /api/extensions/preview → POST /api/extensions with the reviewed toSha), so
// the pin can't be moved to an unreviewed commit. Removed the blind "pull latest".

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const url = new URL(req.url);
  const marketplaceId = url.searchParams.get("marketplaceId");
  const pluginName = url.searchParams.get("pluginName");
  if (!marketplaceId || !pluginName) return Response.json({ error: "marketplaceId and pluginName required" }, { status: 400 });
  // The org-wide install, explicitly. This route is the admin catalog's "uninstall for
  // everyone"; a member's personal copy of the same plugin is theirs, and removing it from
  // under them here would be silent — nothing in this response says whose install it was.
  const installId = await findInstall(marketplaceId, pluginName, { scope: "system", userId: null });
  if (!installId) return Response.json({ error: "Not installed" }, { status: 404 });
  await uninstallPlugin(installId);
  await audit({ actorId: userId, action: "plugin.uninstall", targetType: "plugin", targetKey: pluginName });
  return Response.json({ ok: true });
});
