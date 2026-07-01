import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiHandler, requireActive } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { buildRegistry } from "@/lib/manage/controls";
import { applyPending } from "@/lib/manage/dispatch";
import type { ManageContext } from "@/lib/manage/types";

// Built once — the registry is stateless (controls delegate to the service layer).
const registry = buildRegistry();

const bodySchema = z.object({ pendingId: z.string().min(1) });

/**
 * Apply a change the user STAGED from chat — the human-controlled half of the
 * confirm boundary. Authorization is the session cookie (which the model cannot
 * forge), so a prompt-injected agent that staged a change can never apply it;
 * only this endpoint, reached by the user's own click, consumes the pending id.
 * The identity comes entirely from the session, never the request body.
 */
export const POST = apiHandler(async (req: Request) => {
  const { userId, role } = await requireActive();
  const { pendingId } = bodySchema.parse(await req.json());

  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
  const ctx: ManageContext = {
    userId,
    isAdmin: role === "admin",
    projectId: null, // applyPending overrides this with the pending's staged scope
    locale: u?.locale ?? undefined,
  };

  const result = await applyPending(registry, ctx, pendingId);
  // 200 even for an error result: the card renders the friendly message inline
  // (e.g. "confirmation expired"); this isn't an HTTP-level failure.
  return Response.json(result);
});
