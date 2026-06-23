import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";
import { requireOwned } from "@/lib/db/ownership";

// POST /api/chats/[id]/read — mark the chat read up to now. The sidebar's
// unread dot is derived from `assistant message newer than lastReadAt`, so
// stamping lastReadAt clears it. Deliberately does NOT touch `updatedAt`:
// reading is not activity and must not reorder the sidebar.
export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;
  await requireOwned(chats, id, userId, "Chat");

  await db
    .update(chats)
    .set({ lastReadAt: new Date() })
    .where(and(eq(chats.id, id), eq(chats.userId, userId)));

  return Response.json({ ok: true });
});
