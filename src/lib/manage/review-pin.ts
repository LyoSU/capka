import type { PendingStore } from "./pending";
import type { ManageContext } from "./types";

/** Injected in tests, else the DB-backed one — lazy-imported so a pure test of the
 *  collection never pulls a database in, the same shape `dispatch` uses. */
async function pinStore(ctx: ManageContext): Promise<PendingStore> {
  if (ctx.pending) return ctx.pending;
  return (await import("./pending")).dbPendingStore;
}

/** How long a shown card stays applicable. Long enough to read a repo's skill list and
 *  decide; short enough that an approval clicked tomorrow re-resolves HEAD rather than
 *  installing a commit that has since been replaced. */
const PIN_TTL_MS = 10 * 60_000;

export type ReviewPin = { sha: string; reviewHash: string };

/**
 * The preview→apply hand-off for an approval whose preview resolved a MOVING target.
 *
 * `previewAdd` for a repo install resolves HEAD to a concrete commit, builds the review at
 * that commit and shows it; the separate `add` call must apply THAT review — not re-resolve
 * HEAD, and not apply a plan nobody reviewed. Native tool approval gives the two calls no
 * shared argument to carry the commit in, so it has to be parked between them.
 *
 * It used to be parked in a module-level Map keyed by `userId:repo`, which lost or crossed
 * pins in three ways: a restart or a second replica has no entry at all (the apply then
 * refuses and the user redoes an approval they already gave), and two approvals of the SAME
 * repo differing only in `only`/`scope` overwrite each other — the first confirm walks off
 * with the second's hash, and the second finds nothing.
 *
 * The suspended tool call is what identifies ONE approval, so the pin is keyed by its
 * `toolCallId` and stored in the staging table, which already has the three properties this
 * needs and enforces them in the database rather than in this module: owned by one user,
 * consumable exactly once, and expiring on its own.
 */
export type PinIdentity = { repo: string; scope: string; only: string[] | undefined };

/** What the preview was built FROM, as a value a later call can be compared against. The
 *  key already separates two approvals; this catches the reverse — a pin being spent on a
 *  call whose arguments are not the ones the card described. */
export function pinIdentity(i: PinIdentity): string {
  return JSON.stringify([i.repo.trim(), i.scope, [...(i.only ?? [])].sort()]);
}

/**
 * Park what the card showed against this suspended call.
 *
 * A missing `toolCallId` (an off-turn caller that cannot name one) is a no-op rather than an
 * error: nothing is pinned, so the apply finds nothing and refuses — the same fail-closed
 * outcome as an expired pin, which is the behaviour every miss has.
 */
export async function parkReviewPin(ctx: ManageContext, identity: string, pin: ReviewPin): Promise<void> {
  if (!ctx.toolCallId) return;
  const store = await pinStore(ctx);
  await store.stage(
    { userId: ctx.userId, projectId: ctx.projectId, kind: "review-pin", payload: { ...pin, identity } },
    PIN_TTL_MS,
    ctx.toolCallId,
  );
}

/**
 * Take the pin this call's card left, or undefined when there is none live.
 *
 * `consume` is the same single-use latch a staged confirmation uses: it matches only an
 * unconsumed, unexpired row owned by this user, so an approved call that gets executed
 * twice (the runner re-streams the same tool call on a stall retry) cannot apply the review
 * twice, and no other user's pin is reachable through a guessed id.
 */
export async function claimReviewPin(ctx: ManageContext, identity: string): Promise<ReviewPin | undefined> {
  if (!ctx.toolCallId) return undefined;
  const store = await pinStore(ctx);
  const rec = await store.consume(ctx.toolCallId, ctx.userId);
  if (!rec || rec.kind !== "review-pin") return undefined;
  const p = rec.payload as { sha?: unknown; reviewHash?: unknown; identity?: unknown };
  if (typeof p.sha !== "string" || typeof p.reviewHash !== "string") return undefined;
  if (p.identity !== identity) return undefined;
  return { sha: p.sha, reviewHash: p.reviewHash };
}
