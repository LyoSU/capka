import { apiHandler, requireAdmin } from "@/lib/auth";
import { rebuildSearchDocuments } from "@/lib/vault/search-documents";

/**
 * The repair, exposed. A rebuild nobody can run is the same defect as no rebuild (L7).
 *
 * ONE SPACE PER CALL and idempotent: an operator repairing a suspect space should not have
 * to reindex an instance, and a route that swept everything would be a denial-of-service
 * button on a busy database. The space id comes from the body rather than the path so the
 * route has no dynamic segment to guess at.
 */
export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const body = (await req.json()) as { spaceId?: unknown };
  const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
  if (!spaceId) return Response.json({ error: "spaceId is required" }, { status: 400 });
  const { written } = await rebuildSearchDocuments(spaceId);
  return Response.json({ spaceId, written });
});
