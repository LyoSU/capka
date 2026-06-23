import { apiHandler, requireAdmin } from "@/lib/auth";
import { listInstalledPlugins, setPluginEnabled } from "@/lib/marketplace/service";
import { uninstallPlugin, upgradePlugin } from "@/lib/marketplace/install";
import { audit } from "@/lib/governance/audit";

/** Installed plugins grouped with their skills + connectors (the Extensions hub). */
export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json({ plugins: await listInstalledPlugins() });
});

/** Enable or disable a whole plugin (all its skills + connectors at once). */
export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { installId, enabled } = await req.json();
  if (typeof installId !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "installId and enabled required" }, { status: 400 });
  }
  await setPluginEnabled(installId, enabled);
  await audit({ actorId: userId, action: enabled ? "plugin.enable" : "plugin.disable", targetType: "plugin", targetKey: installId });
  return Response.json({ ok: true });
});

/** Re-pull a plugin from its source (update to latest). */
export const POST = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const { installId } = await req.json();
  if (typeof installId !== "string") return Response.json({ error: "installId required" }, { status: 400 });
  const manifest = await upgradePlugin(installId);
  await audit({ actorId: userId, action: "plugin.update", targetType: "plugin", targetKey: installId, detail: { skills: manifest.skills.length, connectors: manifest.connectors.length } });
  return Response.json({ ok: true, manifest });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const installId = new URL(req.url).searchParams.get("installId");
  if (!installId) return Response.json({ error: "installId required" }, { status: 400 });
  await uninstallPlugin(installId);
  await audit({ actorId: userId, action: "plugin.uninstall", targetType: "plugin", targetKey: installId });
  return Response.json({ ok: true });
});
