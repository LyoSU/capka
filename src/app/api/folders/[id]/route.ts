import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachedFolders } from "@/lib/db/schema";

// Detach a PC folder. Only stops syncing — the workspace copy stays (removing
// files is the user's explicit call). Host folders are removed via `manage`, so
// this route refuses them (treated as not-found to avoid leaking their existence).
export const DELETE = apiHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { userId, role } = await requireActive();
  const { id } = await params;
  const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, id)).limit(1);
  if (!row || row.kind !== "pc" || (row.userId !== userId && role !== "admin")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  await db.delete(attachedFolders).where(eq(attachedFolders.id, id));
  return Response.json({ ok: true });
});
