import { apiHandler, requireSession, requireWriter } from "@/lib/auth";
import { getInstallOwner, listInstalledPlugins, setPluginEnabled, setPluginMutedForUser } from "@/lib/marketplace/service";
import { uninstallPlugin } from "@/lib/marketplace/install";
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

/**
 * GONE ON PURPOSE.
 *
 * This route moved the pin on a reviewed COMMIT, which is not the same thing as having been
 * reviewed: a full SHA proves the target did not drift, and proves nothing about whether a
 * human saw what the plugin would reach. While it existed it was a complete bypass of the
 * consent gate — the barrier could be skipped by choosing the older endpoint, and the UI's
 * own fallback did exactly that whenever the derived review had not loaded.
 *
 * Upgrades go through `GET`/`POST /api/extensions/review`, which is the single server-side
 * writer. Kept as an explicit refusal rather than deleted so an old client gets an answer
 * that says where to go, instead of a 405 it will retry.
 */
export const POST = apiHandler(async () => {
  await requireWriter();
  return Response.json(
    { error: "Upgrades now go through the install review. Use POST /api/extensions/review with the reviewHash it returns." },
    { status: 410 },
  );
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
