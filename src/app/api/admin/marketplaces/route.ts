import { apiHandler, requireAdmin } from "@/lib/auth";
import { addMarketplace, deleteMarketplace, listMarketplaces } from "@/lib/marketplace/service";

export const GET = apiHandler(async () => {
  await requireAdmin();
  return Response.json({ marketplaces: await listMarketplaces() });
});

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const { url } = await req.json();
  if (typeof url !== "string" || !url.trim()) {
    return Response.json({ error: "url required" }, { status: 400 });
  }
  const id = await addMarketplace(url);
  return Response.json({ ok: true, id });
});

export const DELETE = apiHandler(async (req: Request) => {
  await requireAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteMarketplace(id);
  return Response.json({ ok: true });
});
