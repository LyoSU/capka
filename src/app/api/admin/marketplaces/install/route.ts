import { apiHandler, requireAdmin } from "@/lib/auth";
import { installPlugin, uninstallPlugin } from "@/lib/marketplace/install";
import { findInstall } from "@/lib/marketplace/service";

export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { marketplaceId, pluginName } = await req.json();
  if (typeof marketplaceId !== "string" || typeof pluginName !== "string") {
    return Response.json({ error: "marketplaceId and pluginName required" }, { status: 400 });
  }
  const manifest = await installPlugin({ marketplaceId, pluginName, installedBy: userId });
  return Response.json({ ok: true, manifest });
});

export const DELETE = apiHandler(async (req: Request) => {
  await requireAdmin();
  const url = new URL(req.url);
  const marketplaceId = url.searchParams.get("marketplaceId");
  const pluginName = url.searchParams.get("pluginName");
  if (!marketplaceId || !pluginName) return Response.json({ error: "marketplaceId and pluginName required" }, { status: 400 });
  const installId = await findInstall(marketplaceId, pluginName);
  if (!installId) return Response.json({ error: "Not installed" }, { status: 404 });
  await uninstallPlugin(installId);
  return Response.json({ ok: true });
});
