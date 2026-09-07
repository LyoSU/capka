import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db, pool } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";
import { liveLeaseSql } from "@/lib/folders/lease";

// Persist / read the PC-sync base manifest (3-way merge base) around a sync.
// Owner-checked; the manifest is opaque JSON the browser bridge round-trips.

// Rehydrate the base on a fresh tab (page reload wipes the in-memory base, and
// without it deletes stop propagating). Returns the stored state or null.
export const GET = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId, role } = await requireActive();
  const { id } = await params;
  const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  if (!row || (row.userId !== userId && role !== "admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ state: row.state ?? null });
});

export const PUT = apiHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId, role } = await requireActive();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { state?: unknown; expectedRev?: unknown };
  // The base manifest is the merge ancestor — a malformed PUT that omits it (or
  // sends a non-object) must not silently wipe it. Accept only the versioned shape.
  //
  // `null` used to be accepted as "clear the ancestor", and no caller ever sent it,
  // but it made the revision chain reset: null reads as revision 0, so the sequence
  // null → rev 1 → null let a writer still holding expectedRev 0 win the swap and
  // restore its old manifest over a newer one. Nothing can lower the revision now.
  const state = body.state;
  if (typeof state !== "object" || state === null || (state as { v?: unknown }).v !== 1) {
    return Response.json({ error: "Invalid state" }, { status: 400 });
  }
  // A sync holds a folder lease for its whole span, and this row is the one thing a
  // sync that already lost the lease could still win: it writes at the very end,
  // when its own file operations may have been overtaken. So the write carries the
  // token and the server checks it in the same statement as the revision.
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return Response.json({ error: "token required" }, { status: 400 });
  const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  if (!row || (row.userId !== userId && role !== "admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Optimistic concurrency: the bridge sends the revision it based this state on.
  // If the stored revision moved on (another tab/member synced the same folder
  // meanwhile), reject — overwriting would revert their merge ancestor and can
  // resurrect a file they just deleted. The client re-loads and reconciles next sync.
  //
  // The comparison has to live in the UPDATE, not beside it. Reading the row and
  // then writing it left a window wide enough for two tabs to both read the same
  // `rev`, both pass the check, and both write: the guard reported success to both
  // and the second silently reverted the first. Compared as text so a `rev` that
  // isn't a number fails the swap instead of raising a cast error, and so an absent
  // state reads as revision 0 — the same starting point the bridge assumes.
  //
  // The lease predicate sits in the same statement for the same reason, and is the
  // same one the bulk-upload route fences on (see `liveLeaseSql`). A revision claim
  // is optional; holding the lease is not.
  const args: unknown[] = [id, JSON.stringify(state), token];
  let revClause = "";
  if (typeof body.expectedRev === "number") {
    args.push(String(body.expectedRev));
    revClause = ` AND COALESCE(state->>'rev', '0') = $${args.length}`;
  }
  const { rowCount } = await pool.query(
    `UPDATE attached_folders SET state = $2::jsonb, updated_at = now()
      WHERE id = $1 AND ${liveLeaseSql(3)}${revClause}`,
    args,
  );
  // One status for both losses. The client's answer is the same either way: stand
  // down, the ancestor the winner stored is the one the next sync will start from.
  if (!rowCount) return Response.json({ error: "Conflict — folder state changed elsewhere." }, { status: 409 });
  return Response.json({ ok: true });
});
