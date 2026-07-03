import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";

// Persist the PC-sync base manifest (3-way merge base) after a successful sync.
// Owner-checked; the manifest is opaque JSON the browser bridge round-trips.
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
