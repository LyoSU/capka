import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { pool, db } from "@/lib/db";
import { setPolicy } from "@/lib/governance/policy";
import {
  ForbiddenDispositionError, StalePolicyError, analysePolicies, applyDispositions,
  assertDispositionAllowed, policyKey, policyRevisions, readPolicyBaseline,
  type PolicyBaselineRow, type PolicyOutlook,
} from "../policy-disposition";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run policy-disposition.integration
 *
 * §6. Two things here cannot be shown any other way: that `revision` actually
 * distinguishes two updates landing in the SAME millisecond (the case a timestamp cannot),
 * and that a stale disposition affects zero rows and aborts rather than being skipped.
 */
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const NAME = "pdtest-connector";
const ACTOR = "pdtest-actor";
/** The outlooks these cases assert are about the resource, not about entitlement, so they
 *  are read as an admin — `canDelete` has its own cases below. */
const ADMIN_ACTOR = { userId: ACTOR, isAdmin: true };
const cleanup = () => pool.query(`DELETE FROM capability_policies WHERE capability_key LIKE 'pdtest-%'`);

/** `created_by` is a real FK to `user`, so the actor has to exist — an empty string is a
 *  constraint violation, not a null. */
const seedActor = () => pool.query(
  `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
   VALUES ($1, 'pd test', 'pd@test.local', true, now(), now()) ON CONFLICT (id) DO NOTHING`, [ACTOR]);

const seed = (effect: "allow" | "deny" | "ask" = "deny") =>
  setPolicy({ capabilityType: "connector", capabilityKey: NAME, effect, scope: "system", createdBy: ACTOR });

run("policy revision", () => {
  beforeAll(seedActor);
  beforeEach(cleanup);
  afterAll(cleanup);

  it("differs between two consecutive updates, even inside one millisecond", async () => {
    // Exactly the case `updated_at` cannot distinguish: `setPolicy` writes it as
    // `new Date()`, so two updates in the same millisecond produce an identical value and
    // a timestamp CAS would see no change at all.
    await seed("deny");
    const before = (await readPolicyBaseline([{ type: "connector", name: NAME }]))[0];
    await Promise.all([seed("allow"), seed("ask")]);
    const after = (await readPolicyBaseline([{ type: "connector", name: NAME }]))[0];
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("starts at 0 for a freshly inserted rule", async () => {
    await seed();
    expect((await readPolicyBaseline([{ type: "connector", name: NAME }]))[0].revision).toBe(0);
  });

  it("is not bumped by a delete, because the row goes", async () => {
    await seed();
    await pool.query(`DELETE FROM capability_policies WHERE capability_key = $1`, [NAME]);
    expect(await readPolicyBaseline([{ type: "connector", name: NAME }])).toEqual([]);
  });
});

run("readPolicyBaseline", () => {
  beforeAll(seedActor);
  beforeEach(cleanup);
  afterAll(cleanup);

  it("finds a rule by (type, name) and reports it as part of the hashable baseline", async () => {
    await seed();
    const rows = await readPolicyBaseline([{ type: "connector", name: NAME }]);
    expect(rows).toHaveLength(1);
    expect(policyRevisions(rows)).toEqual({ [`system:connector:${NAME}::`]: 0 });
  });

  it("does not confuse a skill and a connector of the same name", async () => {
    // The pair must match, which is why the query zips two arrays rather than matching
    // either column alone.
    await seed();
    expect(await readPolicyBaseline([{ type: "skill", name: NAME }])).toEqual([]);
  });

  it("asks nothing of the database for an empty name list", async () => {
    expect(await readPolicyBaseline([])).toEqual([]);
  });
});

describe("analysePolicies (pure)", () => {
  const row = {
    id: "p1", capabilityType: "connector" as const, capabilityKey: "api", effect: "deny",
    scope: "system", userId: null, projectId: null, revision: 0,
  };

  it("says the rule still applies when another resource answers to that name", () => {
    // A removal does not orphan a policy by itself: `run-context.ts` matches on the NAME
    // and knows nothing about which plugin installed it. Saying "this permission will be
    // removed" here would be false.
    expect(analysePolicies({ affected: [row], survivingNames: [{ type: "connector", name: "api" }], actor: ADMIN_ACTOR })[0].outlook)
      .toBe("still_applies");
  });

  it("says it applies to nothing when the name is gone", () => {
    // And keeping it is then a standing rule for a FUTURE resource of that name, which is
    // why deleting is a choice the installer makes rather than a cleanup we perform.
    expect(analysePolicies({ affected: [row], survivingNames: [], actor: ADMIN_ACTOR })[0].outlook).toBe("applies_to_nothing");
  });

  it("does not treat a same-named SKILL as the surviving connector", () => {
    expect(analysePolicies({ affected: [row], survivingNames: [{ type: "skill", name: "api" }], actor: ADMIN_ACTOR })[0].outlook)
      .toBe("applies_to_nothing");
  });
});

run("applyDispositions", () => {
  beforeAll(seedActor);
  beforeEach(cleanup);
  afterAll(cleanup);

  const baseline = () => readPolicyBaseline([{ type: "connector", name: NAME }]);
  const ADMIN = { userId: "someone", isAdmin: true };
  /** The rule is gone from the new surface, so deleting it is the offered choice. */
  const gone = (rows: PolicyBaselineRow[]): PolicyOutlook[] =>
    analysePolicies({ affected: rows, survivingNames: [], actor: ADMIN_ACTOR });
  const run = (rows: PolicyBaselineRow[], dispositions: Record<string, "keep" | "delete" | "reassign">,
               actor = ADMIN, outlooks = gone(rows)) =>
    db.transaction((tx) => applyDispositions(tx, { dispositions, baseline: rows, outlooks, actor }));

  it("deletes what the installer chose to delete", async () => {
    await seed();
    const rows = await baseline();
    const out = await run(rows, { [policyKey(rows[0])]: "delete" });
    // The ROW, not the key: `policy.clear` has to say what the rule contained, and after the
    // delete it is unreconstructable.
    expect(out.deleted.map((r) => policyKey(r))).toEqual([policyKey(rows[0])]);
    expect(await baseline()).toEqual([]);
  });

  it("leaves `keep` alone", async () => {
    await seed();
    const rows = await baseline();
    await run(rows, { [policyKey(rows[0])]: "keep" });
    expect(await baseline()).toHaveLength(1);
  });

  it("aborts on a stale revision instead of skipping the disposition", async () => {
    // The window the fence does not cover: the policy tables are not plugin-owned, so an
    // admin can edit one between the second hash check and this write. Skipping would apply
    // the resource half of a decision and drop the policy half — the operation would report
    // `succeeded` while what executed is not what was consented to.
    await seed("deny");
    const rows = await baseline();
    await seed("allow"); // someone else moved it; revision advanced
    await expect(run(rows, { [policyKey(rows[0])]: "delete" })).rejects.toThrow(StalePolicyError);
    // Nothing was deleted, and the transaction rolled back.
    expect(await baseline()).toHaveLength(1);
  });

  it("aborts when a disposition names a row that is no longer in the baseline", async () => {
    await expect(run([], { "system:connector:vanished::": "delete" })).rejects.toThrow(StalePolicyError);
  });

  it("refuses a NON-ADMIN deleting a system rule — the escalation this gate exists for", async () => {
    // The attack: a member installs a personal plugin declaring a resource named to match an
    // org-wide `deny`, then names that rule in `dispositions`. A missing rule is DEFAULT
    // ALLOW, so deleting it grants the member what the admin forbade. The review hash cannot
    // stop this: the client supplies the dispositions and the server hashes them WITH the
    // request, so a forged one simply produces a different valid hash.
    await seed("deny");
    const rows = await baseline();
    await expect(run(rows, { [policyKey(rows[0])]: "delete" }, { userId: "member", isAdmin: false }))
      .rejects.toThrow(ForbiddenDispositionError);
    expect(await baseline()).toHaveLength(1);
  });

  it("refuses deleting a rule that still applies to a surviving resource", async () => {
    // Not part of this decision at all, and the screen never offers it — so a request to
    // delete one is forged by construction.
    await seed("deny");
    const rows = await baseline();
    const stillApplies = analysePolicies({ affected: rows, survivingNames: [{ type: "connector", name: NAME }], actor: ADMIN_ACTOR });
    await expect(run(rows, { [policyKey(rows[0])]: "delete" }, ADMIN, stillApplies))
      .rejects.toThrow(ForbiddenDispositionError);
    expect(await baseline()).toHaveLength(1);
  });

  it("refuses a key with no outlook, even for an admin", async () => {
    await seed("deny");
    const rows = await baseline();
    await expect(run(rows, { [policyKey(rows[0])]: "delete" }, ADMIN, []))
      .rejects.toThrow(ForbiddenDispositionError);
  });

  it("refuses `reassign` loudly rather than silently treating it as keep", async () => {
    // Moving a rule to a renamed resource needs a target the review does not carry yet.
    // Quietly keeping would apply something other than what was accepted.
    await seed();
    const rows = await baseline();
    await expect(run(rows, { [policyKey(rows[0])]: "reassign" })).rejects.toThrow(/not implemented/);
  });
});

afterAll(async () => {
  await cleanup();
  await pool.query(`DELETE FROM "user" WHERE id = $1`, [ACTOR]);
});

describe("assertDispositionAllowed (pure — the ownership rule)", () => {
  const row = (over: Partial<PolicyBaselineRow> = {}): PolicyBaselineRow => ({
    id: "p1", capabilityType: "connector", capabilityKey: "api", effect: "deny",
    scope: "system", userId: null, projectId: null, revision: 0, ...over,
  });
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
    const r = row();
    expect(() => assertDispositionAllowed("k", "keep", r, undefined, { userId: "m1", isAdmin: false })).not.toThrow();
  });
});
