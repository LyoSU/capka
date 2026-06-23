import { apiHandler, requireSession } from "@/lib/auth";
import { getInstallOwner, listInstalledPlugins, setPluginEnabled } from "@/lib/marketplace/service";
import { uninstallPlugin, upgradePlugin } from "@/lib/marketplace/install";
import { audit } from "@/lib/governance/audit";

/** May this user manage this install? Admins manage org-wide (system) installs;
 *  a member manages only their own personal (user-scope) install. */
async function canManage(installId: string, userId: string, isAdmin: boolean): Promise<boolean> {
  const owner = await getInstallOwner(installId);
  if (!owner) return false;
  return owner.scope === "user" ? owner.userId === userId : isAdmin;
}

/** Installed plugins grouped with their skills + connectors, scoped to the viewer
 *  (org-wide installs + their own personal ones). Any signed-in user can read +
 *  sign in to OAuth connectors; management is gated per-install below. */
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ plugins: await listInstalledPlugins(userId) });
});

/** Enable or disable a whole plugin (all its skills + connectors at once). */
export const PATCH = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const { installId, enabled } = await req.json();
  if (typeof installId !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "installId and enabled required" }, { status: 400 });
  }
  if (!(await canManage(installId, userId, role === "admin"))) return Response.json({ error: "Not allowed" }, { status: 403 });
  await setPluginEnabled(installId, enabled);
  await audit({ actorId: userId, action: enabled ? "plugin.enable" : "plugin.disable", targetType: "plugin", targetKey: installId });
  return Response.json({ ok: true });
});

/** Re-pull a plugin from its source (update to latest). */
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const { installId } = await req.json();
  if (typeof installId !== "string") return Response.json({ error: "installId required" }, { status: 400 });
  if (!(await canManage(installId, userId, role === "admin"))) return Response.json({ error: "Not allowed" }, { status: 403 });
  const manifest = await upgradePlugin(installId);
  await audit({ actorId: userId, action: "plugin.update", targetType: "plugin", targetKey: installId, detail: { skills: manifest.skills.length, connectors: manifest.connectors.length } });
  return Response.json({ ok: true, manifest });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const installId = new URL(req.url).searchParams.get("installId");
  if (!installId) return Response.json({ error: "installId required" }, { status: 400 });
  if (!(await canManage(installId, userId, role === "admin"))) return Response.json({ error: "Not allowed" }, { status: 403 });
  await uninstallPlugin(installId);
  await audit({ actorId: userId, action: "plugin.uninstall", targetType: "plugin", targetKey: installId });
  return Response.json({ ok: true });
});
