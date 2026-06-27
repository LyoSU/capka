import { apiHandler, requireAdmin } from "@/lib/auth";
import { installPlugin, uninstallPlugin } from "@/lib/marketplace/install";
import { findInstall } from "@/lib/marketplace/service";
import { audit } from "@/lib/governance/audit";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { marketplaceId, pluginName } = await req.json();
  if (typeof marketplaceId !== "string" || typeof pluginName !== "string") {
    return Response.json({ error: "marketplaceId and pluginName required" }, { status: 400 });
  }
  const manifest = await installPlugin({ marketplaceId, pluginName, installedBy: userId });
  await audit({ actorId: userId, action: "plugin.install", targetType: "plugin", targetKey: pluginName, detail: { skills: manifest.skills.length, connectors: manifest.connectors.length } });
  return Response.json({ ok: true, manifest });
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
  const installId = await findInstall(marketplaceId, pluginName);
  if (!installId) return Response.json({ error: "Not installed" }, { status: 404 });
  await uninstallPlugin(installId);
  await audit({ actorId: userId, action: "plugin.uninstall", targetType: "plugin", targetKey: pluginName });
  return Response.json({ ok: true });
});
