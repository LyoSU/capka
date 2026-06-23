import { apiHandler, requireAdmin } from "@/lib/auth";
import { getCatalog } from "@/lib/marketplace/service";

export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  // Scope "installed" to org-wide + this admin's own, so a member's personal
  // install doesn't show as installed in the admin view.
  return Response.json({ items: await getCatalog(id, userId) });
});
