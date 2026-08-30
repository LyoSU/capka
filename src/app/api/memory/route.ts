import { and, eq, isNull } from "drizzle-orm";
import { apiHandler, requireActive, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces } from "@/lib/db/schema";
import { rejectAllCandidates } from "@/lib/vault/candidates";
import { forgetAllClaims } from "@/lib/vault/claims";
import { readMemoryPage } from "@/lib/vault/memory-page";

/**
 * The memory page's own endpoint. It replaces `/api/memory-docs`, which served a
 * markdown projection of the same data — a shape that could carry no provenance, no
 * version history, no waiting list and no controls, because a string has nowhere to put
 * them. That is why there is no interim version of this: changing the response shape and
 * the component that renders it is the same change.
 *
 * `requireActive` and self-scoped: there is no user parameter anywhere here, and an
 * admin reading somebody else's memory is not a thing this route can express. A later
 * task adds PATCH (consent) beside this.
 *
 * `?q=` searches the FACTS. It is a parameter on this route rather than a route of its own
 * for two reasons: the answer is the same projection narrowed, so a second route would be a
 * second reader of it; and a new route DIRECTORY is not picked up by the dev watcher over
 * this repo's bind mount, so Next answers 404 before any handler runs — a symptom that
 * reads exactly like a logic bug and has cost this project an afternoon before.
 */
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireActive();
  const query = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json(await readMemoryPage(userId, query));
});

/**
 * "Forget everything", across every live space this user owns — their own and each of
 * their projects'.
 *
 * WHAT GOES, stated here because the dialog in front of it makes a promise a reader has
 * to be able to check: every live claim head in those spaces, confirmed or not, and every
 * unresolved candidate. WHAT STAYS: the rows themselves (a forget ends a chain, it does
 * not delete — see `forgetAllClaims`), their evidence, their topic attachments, and above
 * all `audit_events`, which is the only record that this reset ever happened. Sweeping
 * the trail in the same act would erase the evidence of the act, which is the one thing a
 * destructive control must not do.
 *
 * Goes through `forgetAllClaims` and `rejectAllCandidates`, never a bare delete: each
 * inverse lives with the writer it undoes, and this route only decides WHICH spaces. One
 * transaction per space, so a scope is never left half-forgotten — memory emptied while
 * the review queue still offers the same facts back.
 *
 * Retired spaces are excluded because their content is already gone; including them would
 * write forget events into a tombstone that Task 11's GC then collects.
 *
 * `forgotten` counts ROWS, which is not the number of facts the page was showing —
 * unverified heads never appear there. Nothing renders it; it is here for the caller that
 * wants to know whether anything happened at all.
 */
export const DELETE = apiHandler(async () => {
  const { userId } = await requireWriter();
  const actor = { kind: "user", id: userId } as const;

  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));

  let forgotten = 0;
  for (const space of mine) {
    forgotten += await db.transaction(async (tx) => {
      const { forgotten: n } = await forgetAllClaims(space.id, actor, tx);
      await rejectAllCandidates(space.id, actor, tx);
      return n;
    });
  }
  return Response.json({ forgotten });
});
