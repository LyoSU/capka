import { eq, and } from "drizzle-orm";
import { requireRole, apiHandler } from "@/lib/auth";
import { db } from "@/lib/db";
import { chats } from "@/lib/db/schema";

// POST /api/chats/[id]/read — mark the chat read up to now. The sidebar's
// unread dot is derived from `assistant message newer than lastReadAt`, so
// stamping lastReadAt clears it. Deliberately does NOT touch `updatedAt`:
// reading is not activity and must not reorder the sidebar.
//
// No ownership 404: the sidebar marks a chat read the moment it is opened, and a
// brand-new chat has an id in the URL before its row exists, so a 404 here was
// the normal case for every fresh chat. The update is scoped to the caller's own
// rows, so an unknown id and someone else's id both write nothing and get the
// same 204 — nothing about either is revealed.
export const POST = apiHandler(async (_req, { params }) => {
  const { userId } = await requireRole("admin", "user");
  const { id } = await params;

  await db
    .update(chats)
    .set({ lastReadAt: new Date() })
    .where(and(eq(chats.id, id), eq(chats.userId, userId)));

  return new Response(null, { status: 204 });
});
