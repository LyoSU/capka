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
  const body = (await req.json().catch(() => ({}))) as { state?: unknown };
  const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  if (!row || (row.userId !== userId && role !== "admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  await db.update(attachedFolders).set({ state: body.state ?? null, updatedAt: new Date() }).where(eq(attachedFolders.id, id));
  return Response.json({ ok: true });
});
