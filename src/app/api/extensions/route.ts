import { apiHandler, requireSession, requireWriter } from "@/lib/auth";
import { getInstallOwner, listInstalledPlugins, setPluginEnabled, setPluginMutedForUser } from "@/lib/marketplace/service";
import { uninstallPlugin, upgradePlugin } from "@/lib/marketplace/install";
import { audit } from "@/lib/governance/audit";

/** The install if this user may manage it, else null. Admins manage org-wide
 *  (system) installs; a member manages only their own personal (user-scope) one.
 *  Returns the row (with its plugin name) so callers can attribute the audit. */
async function canManage(installId: string, userId: string, isAdmin: boolean): Promise<{ pluginName: string } | null> {
  const owner = await getInstallOwner(installId);
  if (!owner) return null;
  const allowed = owner.scope === "user" ? owner.userId === userId : isAdmin;
  return allowed ? owner : null;
}

/** Installed plugins grouped with their skills + connectors, scoped to the viewer
 *  (org-wide installs + their own personal ones). Any signed-in user can read +
 *  sign in to OAuth connectors; management is gated per-install below. */
export const GET = apiHandler(async () => {
  const { userId } = await requireSession();
  return Response.json({ plugins: await listInstalledPlugins(userId) });
});

/** Two distinct controls:
 *  - `{ muted }`  → per-user hide of a shared (system) plugin. Any signed-in user.
 *  - `{ enabled }` → global enable/disable of the whole plugin. Managers only
 *                    (admin for org-wide installs, the owner for a personal one). */
export const PATCH = apiHandler(async (req: Request) => {
  const { userId, role } = await requireWriter();
  const { installId, enabled, muted } = await req.json();
  if (typeof installId !== "string") return Response.json({ error: "installId required" }, { status: 400 });

  if (typeof muted === "boolean") {
    const owner = await getInstallOwner(installId);
    if (!owner) return Response.json({ error: "Not found" }, { status: 404 });
    if (owner.scope !== "system") return Response.json({ error: "Only shared plugins can be hidden per user" }, { status: 400 });
    await setPluginMutedForUser(installId, userId, muted);
    return Response.json({ ok: true });
  }

  if (typeof enabled !== "boolean") return Response.json({ error: "enabled or muted required" }, { status: 400 });
  const inst = await canManage(installId, userId, role === "admin");
  if (!inst) return Response.json({ error: "Not allowed" }, { status: 403 });
  await setPluginEnabled(installId, enabled);
  await audit({ actorId: userId, action: enabled ? "plugin.enable" : "plugin.disable", targetType: "plugin", targetKey: installId, detail: { name: inst.pluginName } });
  return Response.json({ ok: true });
});

/** Re-pull a plugin from its source (update to latest). */
export const POST = apiHandler(async (req: Request) => {
  // requireWriter: re-pulling third-party code is install-class, like POST /install.
  const { userId, role } = await requireWriter();
  const { installId, toSha } = await req.json();
  if (typeof installId !== "string") return Response.json({ error: "installId required" }, { status: 400 });
  // toSha binds the upgrade to the commit the user reviewed (see previewUpgrade).
  // Required and fail-closed: no blind "pull latest" path that skips the review.
  // Must be a full 40-hex commit SHA — a branch/tag/"HEAD" would re-dereference to
  // live upstream HEAD at apply time and defeat the pin (upgradePlugin re-checks).
  if (typeof toSha !== "string" || !/^[0-9a-f]{40}$/.test(toSha)) return Response.json({ error: "toSha (reviewed commit) must be a full 40-character commit SHA" }, { status: 400 });
  const inst = await canManage(installId, userId, role === "admin");
  if (!inst) return Response.json({ error: "Not allowed" }, { status: 403 });
  const manifest = await upgradePlugin(installId, toSha);
  await audit({ actorId: userId, action: "plugin.update", targetType: "plugin", targetKey: installId, detail: { name: inst.pluginName, skills: manifest.skills.length, connectors: manifest.connectors.length } });
  return Response.json({ ok: true, manifest });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { userId, role } = await requireWriter();
  const installId = new URL(req.url).searchParams.get("installId");
  if (!installId) return Response.json({ error: "installId required" }, { status: 400 });
  const inst = await canManage(installId, userId, role === "admin");
  if (!inst) return Response.json({ error: "Not allowed" }, { status: 403 });
  await uninstallPlugin(installId);
  await audit({ actorId: userId, action: "plugin.uninstall", targetType: "plugin", targetKey: installId, detail: { name: inst.pluginName } });
  return Response.json({ ok: true });
});
