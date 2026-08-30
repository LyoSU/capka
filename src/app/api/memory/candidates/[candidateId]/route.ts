import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiHandler, requireWriter } from "@/lib/auth";
import { db } from "@/lib/db";
import { spaces } from "@/lib/db/schema";
import { STATEMENT_MAX_CHARS } from "@/lib/vault/claims";
import { confirmCandidate, rejectCandidate } from "@/lib/vault/candidates";

/**
 * The human's yes or no on a proposed fact — the confirmation surface plan A shipped the
 * ledger for and deliberately did not build.
 *
 * Three findings had to close before this could exist, because each is a hole that only
 * opens once a person can confirm something: the candidate key had to be task-scoped (an
 * approval continuation minted colliding keys), `proposeCandidate` had to stop answering
 * "merged"/"conflict" about a withheld head (a confirm button is what makes sensitive
 * heads with slots producible, turning those two replies into an oracle), and the user's
 * answer inside an `ask` had to count as their own words. All three are closed in the
 * commits preceding this one.
 *
 * `confirmCandidate` re-evaluates the whole policy from scratch and holds its own CAS, so
 * this route is thin by design: it establishes WHO is deciding, and nothing else.
 *
 * `statement` is the person's correction of the extractor's wording. It is validated here
 * only for SHAPE — the cap is the writers' own `STATEMENT_MAX_CHARS`, so the route and
 * the ledger cannot disagree about what fits — and everything the correction MEANS
 * (replacing the text for the dedup read, and taking the human's provenance with it)
 * belongs to `confirmCandidate`, with the rest of the policy.
 */
const bodySchema = z.object({
  decision: z.enum(["confirm", "reject"]),
  // TRIMMED before the length is checked, not after. `fitStatement` trims downstream, so
  // validating the raw string let `"   a   "` past a `min(3)` and store a one-character
  // claim — the browser guards it, the API did not, and the API is the contract.
  statement: z.string().trim().min(3).max(STATEMENT_MAX_CHARS).optional(),
});

export const POST = apiHandler(async (req: Request, ctx: { params: Promise<{ candidateId: string }> }) => {
  const { userId } = await requireWriter();
  const { candidateId } = await ctx.params;
  // `req.json()` throws a SyntaxError on a malformed body, and `apiHandler` only
  // special-cases `ZodError` — so a client fault came back as a 500 with a stack trace in
  // the operator's log. Turned into the same 400 an invalid `decision` already produced.
  const raw = await req.json().catch(() => null);
  if (raw === null || typeof raw !== "object") {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { decision, statement } = bodySchema.parse(raw);

  const mine = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), isNull(spaces.retiredAt)));
  const allowedSpaceIds = mine.map((s) => s.id);
  const actor = { kind: "user", id: userId } as const;

  if (decision === "reject") {
    const res = await rejectCandidate({ candidateId, allowedSpaceIds, actor });
    return res.ok ? Response.json({ ok: true }) : Response.json({ error: "not_found" }, { status: 404 });
  }

  const res = await confirmCandidate({ candidateId, allowedSpaceIds, actor, statement });
  if (res.ok) return Response.json({ ok: true, claimId: res.claimId });
  // `try_again` is live contention for a slot — a real "come back in a moment", not a
  // failure. Separated from the other two so the page can say the two different sentences
  // a person actually needs.
  if (res.reason === "try_again") return Response.json({ error: "try_again" }, { status: 409 });
  return Response.json({ error: res.reason }, { status: 404 });
});
