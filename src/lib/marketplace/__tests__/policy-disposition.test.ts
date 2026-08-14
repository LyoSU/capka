import { describe, it, expect } from "vitest";
import {
  ForbiddenDispositionError, analysePolicies, assertDispositionAllowed, policyKey,
  type PolicyBaselineRow, type PolicyOutlook,
} from "../policy-disposition";

/**
 * The parts of the disposition decision that are pure functions of their arguments.
 *
 * They used to sit inside `policy-disposition.integration.test.ts`, marked "(pure)" by hand.
 * Nothing about them needs a database, and a suite that needs no database should not be
 * reachable only from the job that has one — so they moved out rather than staying labelled.
 */

const row = (over: Partial<PolicyBaselineRow> = {}): PolicyBaselineRow => ({
  id: "p1", capabilityType: "connector", capabilityKey: "api", effect: "deny",
  scope: "system", userId: null, projectId: null, revision: 0, ...over,
});

/** These cases are about the resource, not about entitlement — `canDelete` has its own below. */
const ADMIN_ACTOR = { userId: "pdtest-actor", isAdmin: true };

describe("analysePolicies", () => {
  it("says the rule still applies when another resource answers to that name", () => {
    // A removal does not orphan a policy by itself: `run-context.ts` matches on the NAME
    // and knows nothing about which plugin installed it. Saying "this permission will be
    // removed" here would be false.
    expect(analysePolicies({ affected: [row()], survivingNames: [{ type: "connector", name: "api" }], actor: ADMIN_ACTOR })[0].outlook)
      .toBe("still_applies");
  });

  it("says it applies to nothing when the name is gone", () => {
    // And keeping it is then a standing rule for a FUTURE resource of that name, which is
    // why deleting is a choice the installer makes rather than a cleanup we perform.
    expect(analysePolicies({ affected: [row()], survivingNames: [], actor: ADMIN_ACTOR })[0].outlook).toBe("applies_to_nothing");
  });

  it("does not treat a same-named SKILL as the surviving connector", () => {
    expect(analysePolicies({ affected: [row()], survivingNames: [{ type: "skill", name: "api" }], actor: ADMIN_ACTOR })[0].outlook)
      .toBe("applies_to_nothing");
  });
});

describe("assertDispositionAllowed (the ownership rule)", () => {
  const gone = (r: PolicyBaselineRow): PolicyOutlook =>
    ({ key: policyKey(r), capabilityType: r.capabilityType, capabilityKey: r.capabilityKey, effect: r.effect, outlook: "applies_to_nothing", canDelete: true });

  it("lets a member delete only a rule that is theirs", () => {
    const mine = row({ scope: "user", userId: "m1" });
    expect(() => assertDispositionAllowed("k", "delete", mine, gone(mine), { userId: "m1", isAdmin: false })).not.toThrow();
    // Someone else's personal rule is not theirs to touch either — the gate is ownership,
    // not merely "is it user-scoped".
    const theirs = row({ scope: "user", userId: "m2" });
    expect(() => assertDispositionAllowed("k", "delete", theirs, gone(theirs), { userId: "m1", isAdmin: false })).toThrow(ForbiddenDispositionError);
    const project = row({ scope: "project", projectId: "pr1", userId: null });
    expect(() => assertDispositionAllowed("k", "delete", project, gone(project), { userId: "m1", isAdmin: false })).toThrow(ForbiddenDispositionError);
  });

  it("never blocks `keep`, whoever asks", () => {
    // Keeping is the default and changes nothing, so it needs no entitlement — otherwise a
    // member could not submit a review that merely lists somebody else's rule.
    expect(() => assertDispositionAllowed("k", "keep", row(), undefined, { userId: "m1", isAdmin: false })).not.toThrow();
  });
});

/**
 * `canDelete` is what the SCREEN reads, and it has to reach the same verdict the enforcement
 * will. These two answering differently is not a cosmetic bug: a checkbox the apply then
 * refuses lands as a `ForbiddenDispositionError` INSIDE the operation, which marks the install
 * `failed` — so an offer the UI should never have made leaves a plugin needing attention.
 */
describe("analysePolicies canDelete (what the screen may offer)", () => {
  const analyse = (r: PolicyBaselineRow, actor: { userId: string; isAdmin: boolean }, surviving: { type: "connector"; name: string }[] = []) =>
    analysePolicies({ affected: [r], survivingNames: surviving, actor })[0];

  it("offers a member nothing on an ORG-WIDE rule, even when it is orphaned", () => {
    // The exact path of the P0: a member installs a personal plugin declaring a resource named
    // to match an org-wide `deny`, and a missing rule is DEFAULT ALLOW. Enforcement refuses it;
    // the screen must not have offered it in the first place.
    const o = analyse(row(), { userId: "m1", isAdmin: false });
    expect(o.outlook).toBe("applies_to_nothing");
    expect(o.canDelete).toBe(false);
  });

  it("offers a member their OWN orphaned rule", () => {
    expect(analyse(row({ scope: "user", userId: "m1" }), { userId: "m1", isAdmin: false }).canDelete).toBe(true);
  });

  it("offers nobody a rule that still applies — not even an admin", () => {
    // Both gates are independent, and this is the second one. A rule still governing a
    // surviving resource is not part of this decision at all.
    const o = analyse(row(), { userId: "a1", isAdmin: true }, [{ type: "connector", name: "api" }]);
    expect(o.outlook).toBe("still_applies");
    expect(o.canDelete).toBe(false);
  });

  it("agrees with the enforcement on every combination", () => {
    // Written as a cross-product rather than as cases, because the failure mode is the two
    // predicates DRIFTING — and a hand-picked case list is exactly what stops covering the
    // combination somebody adds later.
    const rows = [row(), row({ scope: "user", userId: "m1" }), row({ scope: "user", userId: "m2" }), row({ scope: "project", projectId: "pr1" })];
    const actors = [{ userId: "m1", isAdmin: false }, { userId: "a1", isAdmin: true }];
    const survivingSets = [[], [{ type: "connector" as const, name: "api" }]];
    for (const r of rows) for (const actor of actors) for (const surviving of survivingSets) {
      const o = analyse(r, actor, surviving);
      let enforcementAllows = true;
      try { assertDispositionAllowed(o.key, "delete", r, o, actor); } catch { enforcementAllows = false; }
      expect(o.canDelete, `${r.scope}/${r.userId ?? "-"} as ${actor.isAdmin ? "admin" : actor.userId}, surviving=${surviving.length}`)
        .toBe(enforcementAllows);
    }
  });
});
