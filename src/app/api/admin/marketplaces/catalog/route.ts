import { apiHandler, requireAdmin } from "@/lib/auth";
import { getCatalog } from "@/lib/marketplace/service";

export const GET = apiHandler(async (req: Request) => {
  await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  return Response.json({ items: await getCatalog(id) });
});
