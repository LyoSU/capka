import { and, eq, isNull } from "drizzle-orm";
import { apiHandler, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces } from "@/lib/db/schema";
import { resolveConflict } from "@/lib/vault/claims";

/**
 * The person's answer to a disagreement between two of their own facts.
 *
 * §4.5 step 5 records a correction it may not apply as a live row pointing at the fact it
 * contests — that happens when the replacement carries less authority than its target, or
 * when the turn had read a document or a web page. Neither is a refusal: the design's
 * answer to "I cannot tell whether this correction is the user's" is a card the person
 * taps, and this route is the far end of that tap.
 *
 * IT SENDS ONE ID AND ONE WORD. The id addresses the CONTESTING row — the one carrying
 * `conflicts_with` — and the word says what to keep; which row loses is derived from the
 * stored pointer inside `resolveConflict`. A client naming the loser itself would be a
 * second address for one decision, and this repo's own record says a rule with two
 * entrances is a rule with one of them wrong.
 *
 * No text is sent and none comes back, exactly as the delete route sends none: authority
 * here is established by the SESSION, not by any words a page the agent fetched could
 * have supplied. A sensitive fact is resolved like any other.
 */
export const POST = apiHandler(async (req: Request, ctx: { params: Promise<{ claimId: string }> }) => {
  const { userId } = await requireWriter();
  const { claimId } = await ctx.params;

  const body = (await req.json().catch(() => null)) as { keep?: unknown } | null;
  // A closed set, checked here rather than trusted: `resolveConflict`'s `keep` is a union,
  // so an unchecked cast would be the one place a request body could widen it.
  const keep = body?.keep;
  if (keep !== "both" && keep !== "this" && keep !== "other") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));

  const res = await resolveConflict({
    claimId,
    keep,
    allowedSpaceIds: mine.map((s) => s.id),
    // The whole point of the route. `memory_fact_write` acts as the agent and cannot
    // resolve its own disagreement; this is the person, and the audit log records which.
    actor: { kind: "user", id: userId },
  });
  // One answer for "no such conflict", "not yours" and "already resolved", deliberately:
  // telling them apart would make another user's claim ids probeable one at a time.
  return res.ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
});
