import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireSession, apiHandler } from "@/lib/auth";
import { isValidTimezone } from "@/lib/timezone";

/** Persist the signed-in user's IANA timezone. Auto-detected from the browser
 *  (no manual picker), so it's fire-and-forget; the agent reads it back per-run
 *  to localize the conversation's start date. */
export const PUT = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { timezone } = await req.json();
  if (!isValidTimezone(timezone)) {
    return Response.json({ error: "Invalid timezone" }, { status: 400 });
  }
  await db.update(users).set({ timezone }).where(eq(users.id, userId));
  return Response.json({ ok: true });
});
