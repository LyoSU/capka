import { confirmClaim, createClaim, type Actor, type ClaimInput, type SourceClass } from "../claims";
import type { ServerClass } from "../grounding";
import type { Ex } from "../spaces";

/** A `ServerClass` for a fixture, and the ONLY cast outside `grounding.ts`.
 *
 *  It is legitimate and it is not a hole: the roster guard in `model-view.test.ts` walks
 *  production files only (`ALL_SRC` skips `__tests__`), so this cast is out of its scope
 *  by construction — which is correct, because a test cannot ship. The guard carries a
 *  second assertion that `testServerClass` appears in ZERO production files, so the
 *  escape hatch cannot migrate into one. */
export const testServerClass = (c: SourceClass) => c as ServerClass;

/**
 * A claim in the state a person has approved — which is now TWO writes, and that is the
 * point of this helper existing rather than a `reviewStatus: "confirmed"` field.
 *
 * `createClaim` no longer accepts its own authorization: every new claim lands
 * `unverified` at the column default, and `confirmClaim` is the single write that can
 * move it. A fixture that could still mint a confirmed claim in one call would be able
 * to set up a world the product cannot reach, and would go on passing after the one
 * write that grants authority stopped being called at all.
 *
 * It asserts the confirmation landed. `confirmClaim` returns whether it hit a live head,
 * and a fixture that ignored that would build a silently unconfirmed claim and then fail
 * somewhere far away, as an assertion about a projection.
 */
export async function seedConfirmedClaim(
  input: ClaimInput,
  actor: Actor,
  ex?: Ex,
): Promise<{ id: string; revision: number; sensitive: boolean }> {
  const claim = await createClaim(input, actor, ex);
  const confirmed = await confirmClaim(claim.id, claim.sensitive, actor, ex);
  if (!confirmed) throw new Error(`fixture: claim ${claim.id} was not confirmable`);
  return claim;
}
