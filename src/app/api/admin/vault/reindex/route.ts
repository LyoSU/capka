import { apiHandler, requireAdmin } from "@/lib/auth";
import { containsParity } from "@/lib/vault/edges";
import { rebuildSearchDocuments } from "@/lib/vault/search-documents";

/**
 * The repair, exposed. A rebuild nobody can run is the same defect as no rebuild (L7).
 *
 * ONE SPACE PER CALL and idempotent: an operator repairing a suspect space should not have
 * to reindex an instance, and a route that swept everything would be a denial-of-service
 * button on a busy database. The space id comes from the body rather than the path so the
 * route has no dynamic segment to guess at.
 *
 * `containsParity` rides along as §11.5's PRODUCTION reading, and only as a reading: in dev
 * the control throws inside the writer's own transaction, but a running instance must not
 * lose a person's memory write to a bookkeeping disagreement, so out here it is reported
 * and nothing more. Reported by the reindex route rather than by a route of its own because
 * this is already the operator's "is this space's derived state sound" button, and the
 * dual-write is derived state with a deletion date — a second endpoint would outlive the
 * question it answers.
 *
 * It does NOT repair. The rebuild above repairs the projection because the projection is
 * derivable from the subtype rows; a divergence between `note_claims` and `vault_edges` is
 * two writers disagreeing, and picking a winner here would erase the evidence of which one
 * is wrong before the read switch chooses one of them.
 */
export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const body = (await req.json()) as { spaceId?: unknown };
  const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
  if (!spaceId) return Response.json({ error: "spaceId is required" }, { status: 400 });
  const { written } = await rebuildSearchDocuments(spaceId);
  const parity = await containsParity(spaceId);
  return Response.json({ spaceId, written, containsParity: parity });
});
