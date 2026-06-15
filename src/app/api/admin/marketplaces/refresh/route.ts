import { apiHandler, requireAdmin } from "@/lib/auth";
import { refreshMarketplace } from "@/lib/marketplace/service";

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { id } = await req.json();
  if (typeof id !== "string") return Response.json({ error: "id required" }, { status: 400 });
  await refreshMarketplace(id);
  return Response.json({ ok: true });
});
