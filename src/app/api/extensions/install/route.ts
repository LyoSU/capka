import { apiHandler, requireSession } from "@/lib/auth";
import { membersCanInstallPlugins } from "@/lib/settings";
import { installPlugin } from "@/lib/marketplace/install";
import { hasSystemInstall } from "@/lib/marketplace/service";
import { audit } from "@/lib/governance/audit";

/** Install a plugin from an admin-connected marketplace. Admins install org-wide
 *  (system); members install personally (user-scope) — and only when the admin has
 *  enabled member installs. */
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const isAdmin = role === "admin";
  if (!isAdmin && !(await membersCanInstallPlugins())) {
    return Response.json({ error: "Plugin installs are admin-only on this instance." }, { status: 403 });
  }
  const { marketplaceId, pluginName } = await req.json();
  if (typeof marketplaceId !== "string" || typeof pluginName !== "string") {
    return Response.json({ error: "marketplaceId and pluginName required" }, { status: 400 });
  }
  // A member needn't install personally what's already available org-wide.
  if (!isAdmin && (await hasSystemInstall(marketplaceId, pluginName))) {
    return Response.json({ error: "This plugin is already installed for everyone." }, { status: 409 });
  }
  const scope = isAdmin ? "system" : "user";
  const manifest = await installPlugin({ marketplaceId, pluginName, installedBy: userId, scope });
  await audit({ actorId: userId, action: "plugin.install", targetType: "plugin", targetKey: pluginName, detail: { scope, skills: manifest.skills.length, connectors: manifest.connectors.length } });
  return Response.json({ ok: true, manifest });
});
