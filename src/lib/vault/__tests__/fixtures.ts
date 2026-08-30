import { confirmClaim, createClaim, type Actor, type ClaimInput } from "../claims";
import type { Ex } from "../spaces";

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
