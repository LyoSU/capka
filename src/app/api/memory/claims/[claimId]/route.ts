import { and, eq, isNull } from "drizzle-orm";
import { apiHandler, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces } from "@/lib/db/schema";
import { findCurrentHead, forgetClaim } from "@/lib/vault/claims";

/**
 * The human's delete — and the far end of the dead end recorded on `memory_forget`.
 *
 * That gate is NOT loosened here. It is about establishing that a request came from the
 * person rather than from a page the agent fetched, and here that is established by the
 * session, not by the text: no words are sent at all. The request is an id, and the id
 * came from the user's own screen. A sensitive claim is deleted exactly like any other,
 * and its text appears in neither the request nor the response.
 *
 * Goes through `forgetClaim`, never a bare delete: the inverse lives beside the writer
 * it undoes, and the audit event — actor `user`, not `agent` — is what makes the
 * deletion visible afterwards and tells the two kinds of deletion apart.
 */
export const DELETE = apiHandler(async (_req: Request, ctx: { params: Promise<{ claimId: string }> }) => {
  const { userId } = await requireWriter();
  const { claimId } = await ctx.params;

  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));
  const allowedSpaceIds = mine.map((s) => s.id);

  // The revision is read here rather than sent by the client. A memory page is a
  // low-contention surface, and the alternative — the browser echoing a revision back —
  // buys optimistic concurrency the user cannot act on: there is no "someone else
  // changed this, look again" step for a person deleting their own fact, and a lost CAS
  // would read to them as a button that did nothing.
  const head = await findCurrentHead(claimId, allowedSpaceIds);
  // One answer for "no such fact" and "not yours", deliberately: telling them apart
  // would make another user's claim ids probeable one at a time.
  if (!head) return Response.json({ error: "not_found" }, { status: 404 });

  const res = await forgetClaim({
    claimId: head.id,
    expectedRevision: head.revision,
    allowedSpaceIds,
    // The whole point of this route. `memory_forget` acts as `{ kind: "agent" }` and has
    // to prove the user asked; this is the user asking, and the audit log records which.
    actor: { kind: "user", id: userId },
  });
  // Only reachable if the head moved between the read and the CAS — which, for a person
  // deleting their own fact, means it is already gone.
  return res.ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
});
