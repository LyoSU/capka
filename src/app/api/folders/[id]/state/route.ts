import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";

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
  const state = body.state;
  if (state === undefined || (state !== null && (typeof state !== "object" || (state as { v?: unknown }).v !== 1))) {
    return Response.json({ error: "Invalid state" }, { status: 400 });
  }
  const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  if (!row || (row.userId !== userId && role !== "admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Optimistic concurrency: the bridge sends the revision it based this state on.
  // If the stored revision moved on (another tab/member synced the same folder
  // meanwhile), reject — overwriting would revert their merge ancestor and can
  // resurrect a file they just deleted. The client re-loads and reconciles next sync.
  if (typeof body.expectedRev === "number") {
    const currentRev = (row.state as { rev?: number } | null)?.rev ?? 0;
    if (currentRev !== body.expectedRev) {
      return Response.json({ error: "Conflict — folder state changed elsewhere." }, { status: 409 });
    }
  }
  await db.update(attachedFolders).set({ state, updatedAt: new Date() }).where(eq(attachedFolders.id, id));
  return Response.json({ ok: true });
});
