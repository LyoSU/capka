import { apiHandler, requireSession } from "@/lib/auth";
import { getInstallOwner } from "@/lib/marketplace/service";
import { previewUpgrade } from "@/lib/marketplace/install";

/** Read-only preview of what an upgrade would change (target commit + file diff),
 *  so a manager can review before moving the pin. No DB writes; gated to whoever
 *  may manage the install (admin for org-wide, the owner for a personal one). */
export const GET = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const installId = new URL(req.url).searchParams.get("installId");
  if (!installId) return Response.json({ error: "installId required" }, { status: 400 });

  const owner = await getInstallOwner(installId);
  if (!owner) return Response.json({ error: "Not found" }, { status: 404 });
  const canManage = owner.scope === "user" ? owner.userId === userId : role === "admin";
  if (!canManage) return Response.json({ error: "Not allowed" }, { status: 403 });

  return Response.json(await previewUpgrade(installId));
});
