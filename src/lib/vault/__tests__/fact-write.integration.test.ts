import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_fact_write`, §4.5, IN ITS EVALUATION ORDER — one case per step.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The order is the subject, not a detail of it: §4.5's own round-2 fix was a renumbering,
 * because round 1 evaluated scope legality before the class existed and the check therefore
 * always passed. So each case is named for the step it pins, and the two step-5 cases are
 * BOTH supersede conditions — the server-verified class comparison and the turn's taint —
 * because either one alone lets the settled attack through.
 */
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import { createClaim, type SourceClass } from "../claims";
import { makeHandleMap, type HandleMap } from "../handles";
import { SAID, factWrite, mayOutrank, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

/** Every `SourceClass`, and exhaustive BY CONSTRUCTION rather than by care — written as the
 *  KEYS OF A TOTAL RECORD, not as an array, because `satisfies SourceClass[]` would only
 *  check that each entry IS a class and would happily accept four of the five. A sixth class
 *  is a compile error here exactly as it is in `CLASS_RANK`, so the pin below cannot quietly
 *  stop covering one — which is the failure mode review MED-1 found in the code and MED-2
 *  found in this test's predecessor. */
const CLASSES = Object.keys({
  legacy_confirmed: true,
  owner_authored: true,
  user_direct: true,
  agent_inferred: true,
  untrusted_derived: true,
} satisfies Record<SourceClass, true>) as SourceClass[];

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "fwtest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

/** The turn's last user message, and BOTH quote cases below are located in it: one whose
 *  statement is made of what is there (clause 4 holds) and one whose statement is not
 *  (clause 4 fails, which is the NEW-4 case). Its wording is the fixture — the quotes are
 *  substrings of it, outside any `QUOTED` span. */
const USER_TURN = "I prefer EUR for everything, and please check this for me before Friday.";

let handles: HandleMap;

/** One `WriteCtx`, with the two knobs every case turns: whether the turn has read
 *  something it did not author, and whether the chat is inside a project. The taint's
 *  `write` is injected as a no-op — this suite has no `messages` row and the flag under
 *  test is the one the ctx already carries, not the column update `turn-taint`'s own
 *  suite covers. */
const ctxWith = (a: { tainted: boolean; project?: string | null }): WriteCtx => ({
  userSpaceId: US,
  projectSpaceId: a.project === undefined ? PS : a.project,
  handles,
  taint: makeTurnTaint({ messageId: `${P}msg`, seeded: a.tainted, write: async () => {} }),
  budget: makeVaultBudget(),
  taskId: `${P}task`,
  messageId: `${P}msg`,
  userTurnText: USER_TURN,
  actor: { kind: "agent" },
});

const clean = (o: { project?: string | null } = {}) => ctxWith({ tainted: false, ...o });
const tainted = (o: { project?: string | null } = {}) => ctxWith({ tainted: true, ...o });
/** A clean turn inside a project chat — the Q1 case's whole point is that the CHAT is a
 *  project one while the fact is about the person. */
const inProject = () => clean();

const claimIdOf = (handle: string) => handles.resolve(handle)!.nodeId;

const claimCount = async (spaceId: string) =>
  Number((await q(`SELECT count(*) AS c FROM vault_claims WHERE space_id = $1`, [spaceId])).rows[0].c);

const rowOf = async (handle: string) =>
  (await q(`SELECT * FROM vault_claims WHERE id = $1`, [claimIdOf(handle)])).rows[0];

const spaceOf = async (handle: string) => (await rowOf(handle)).space_id as string;
const conflictsWithOf = async (handle: string) => (await rowOf(handle)).conflicts_with as string | null;

/** Which conversation a saved fact points back at — the relation the memory page turns into
 *  «from the chat "…", 30 August». Ordered, so the assertion is about the set and not about
 *  whatever the planner returns. */
const evidenceMessages = async (handle: string) =>
  (
    await q(`SELECT message_id FROM claim_evidence WHERE claim_id = $1 ORDER BY message_id`, [claimIdOf(handle)])
  ).rows.map((r) => r.message_id as string);

const claimById = async (claimId: string) =>
  (await q(`SELECT * FROM vault_claims WHERE id = $1`, [claimId])).rows[0];

const auditPayload = async (handle: string, action: string) =>
  (
    await q(`SELECT payload FROM audit_events WHERE subject_id = $1 AND action = $2`, [claimIdOf(handle), action])
  ).rows[0].payload as Record<string, unknown>;

/** A live head in a space, at a stated class, addressed by a freshly minted handle — which
 *  is the only address `memory_fact_write` accepts. */
const seedHead = async (spaceId: string, statement: string, sourceClass: SourceClass) => {
  const claim = await createClaim(
    { spaceId, statement, origin: { kind: "seed" }, sourceClass: testServerClass(sourceClass) },
    { kind: "user", id: `${P}u` },
  );
  return { id: claim.id, handle: handles.mint({ kind: "m", spaceId, nodeId: claim.id }) };
};

run("memory_fact_write", () => {
  beforeEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [US, `${P}u`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      PS,
      `${P}proj`,
      `${P}u`,
    ]);
    // ONE map per test, exactly as one map per RUN in production: a handle minted in an
    // earlier case resolving in a later one would be the cross-turn address the whole
    // scheme exists to make impossible.
    handles = makeHandleMap();
  });

  afterEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
  });

  it("step 3 — untrusted_derived is REFUSED into a user space, never downgraded or re-scoped", async () => {
    const r = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "The supplier ships on Fridays",
      grounding: { kind: "agent_inference" },
      ctx: tainted(),
    });
    expect(r.status).toBe("refused_scope");
    expect(await claimCount(US)).toBe(0);
    // And not re-scoped into the project either: "refused" means nothing was written
    // anywhere, which is the half a silent fallback would satisfy the first assertion with.
    expect(await claimCount(PS)).toBe(0);
  });

  it("records the conversation the fact came out of, on a create AND on a supersede", async () => {
    // WHAT WAS MISSING, and what it cost. `runExtraction` attaches `claim_evidence` and this
    // path did not, so a fact the model saved with the writer this release steers every turn
    // towards arrived on the memory page under "the conversation is no longer available" —
    // thirty seconds after the person watched it be saved, on the one screen they can undo
    // it from. `claim_evidence.message_id` is the only thing that lets the page name a chat.
    //
    // BOTH ARMS, because they are two `createClaim`/`updateClaim` calls and one missing line
    // is exactly how this shipped: the supersede writes a NEW row whose words were composed
    // in THIS turn, so it gets its own evidence rather than the predecessor's carried over.
    const created = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: clean(),
    });
    if (created.status !== "created") throw new Error("narrowing");
    expect(await evidenceMessages(created.handle)).toEqual([`${P}msg`]);

    const superseded = await factWrite({
      op: { kind: "replace", targetHandle: created.handle, expectedRevision: 1 },
      statement: "I prefer USD",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: clean(),
    });
    if (superseded.status !== "superseded") throw new Error("narrowing");
    expect(await evidenceMessages(superseded.handle)).toEqual([`${P}msg`]);
  });

  it("step 3 — a NON-untrusted personal fact stated inside a project chat DOES write to personal memory (Q1)", async () => {
    const r = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: inProject(),
    });
    expect(r).toMatchObject({ status: "created", sourceClass: "user_direct" });
    if (r.status !== "created") throw new Error("narrowing");
    expect(await spaceOf(r.handle)).toBe(US);
    // The channel is the database's, read back off the row — not a second copy of the
    // generated column's expression written into the return.
    expect(r.promptAccess).toBe("manifest");
  });

  it("step 3 — refuses with its own sentence when there is no project to file into", async () => {
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The supplier ships on Fridays",
      grounding: { kind: "agent_inference" },
      ctx: tainted({ project: null }),
    });
    expect(r.status).toBe("refused_no_project");
    // Never absorbed into the user space, which is the failure mode the status exists for.
    expect(await claimCount(US)).toBe(0);
  });

  it("step 3 — the fence stands on REPLACE too: an untrusted correction cannot reach a user-space fact", async () => {
    // The arm a create-only fence would leave open, and it is the one that matters most:
    // addressing a personal fact by handle instead of scoping to it would be a document's
    // words rewriting the person's own, which is exactly what step 3 is above step 5 for.
    const target = await seedHead(US, "Acme invoices are paid monthly", "user_direct");
    const r = await factWrite({
      op: { kind: "replace", targetHandle: target.handle, expectedRevision: 1 },
      statement: "Acme invoices are paid quarterly",
      grounding: { kind: "agent_inference" },
      ctx: tainted(),
    });
    // NOT `recorded_conflict`: scope legality answers first and refuses outright, so step 5
    // is never reached and no row lands in the user space at all.
    expect(r.status).toBe("refused_scope");
    expect(await claimCount(US)).toBe(1);
    expect((await claimById(target.id)).superseded_at).toBeNull();
  });

  it("step 3 — an untrusted fact with no project to hold it gets the no-project sentence, not the scope one", async () => {
    // The route round 1 missed (review MED-3): the model asked for `scope: "user"`, so the
    // hoisted no-project arm never ran, and the class came out `untrusted_derived` in a
    // tainted turn — refused at the fence with a sentence that says "save it to the project,
    // or state it as your own conclusion". There is no project, and restating it as an
    // inference floors at `untrusted_derived` again, so BOTH halves of that sentence are
    // dead ends in exactly the circumstance §4.5 wrote a different one for.
    const r = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "The supplier ships on Fridays",
      grounding: { kind: "agent_inference" },
      ctx: tainted({ project: null }),
    });
    expect(r.status).toBe("refused_no_project");
    expect(r.said).toContain("nowhere to store knowledge taken from documents or web pages");
    // Asserted as a DIFFERENCE, not only as a status: the two sentences are the finding.
    expect(r.said).not.toBe(SAID.refused_scope);
    expect(await claimCount(US)).toBe(0);

    // The control on the same fence: WITH a project, the same call is `refused_scope`,
    // because "save it to the project" is then an instruction the model can follow.
    const withProject = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "The supplier ships on Fridays",
      grounding: { kind: "agent_inference" },
      ctx: tainted(),
    });
    expect(withProject.status).toBe("refused_scope");
  });

  it("step 4 — an exact normalized_hash duplicate writes nothing and returns the existing handle", async () => {
    const first = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);

    // Same words, different whitespace and case — `dedupKeyNorm` collapses both, so this is
    // the same key and not a second fact.
    const again = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "  the OFFICE   moved to Lviv ",
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(again).toMatchObject({ status: "known", handle: first.handle });
    expect(await claimCount(PS)).toBe(1);
  });

  it("step 5 — a weaker class does not supersede; it lands as a stored conflict", async () => {
    const target = await seedHead(PS, "Acme invoices are paid monthly", "user_direct");
    const r = await factWrite({
      op: { kind: "replace", targetHandle: target.handle, expectedRevision: 1 },
      statement: "Acme invoices are paid quarterly",
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "recorded_conflict", reason: "weaker_class" });
    if (r.status !== "recorded_conflict") throw new Error("narrowing");
    expect(await conflictsWithOf(r.handle)).toBe(target.id);
    // UNTOUCHED: still revision 1, still the live head. A supersede would have written
    // `superseded_at`, which is the half a revision check alone does not see.
    const prev = await claimById(target.id);
    expect(prev.revision).toBe(1);
    expect(prev.superseded_at).toBeNull();
    // The contesting row is live at its OWN class, not quarantined and not the target's.
    expect((await rowOf(r.handle)).source_class).toBe("agent_inferred");
    // The model is handed the target's HANDLE, never its persistent id.
    expect(JSON.stringify(r)).not.toContain(target.id);
  });

  it("step 5 — an equal class in a TAINTED turn does not supersede either (N2)", async () => {
    const target = await seedHead(PS, "Acme invoices are paid monthly", "user_direct");
    // The quote earns `user_direct` even in a tainted turn — `classify` deliberately does
    // not tax a sentence the person typed for a file's presence in the same turn. So the
    // classes are EQUAL here and only the second condition can refuse the supersede.
    const r = await factWrite({
      op: { kind: "replace", targetHandle: target.handle, expectedRevision: 1 },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: tainted(),
    });
    expect(r).toMatchObject({ status: "recorded_conflict", reason: "untrusted_turn", sourceClass: "user_direct" });
    if (r.status !== "recorded_conflict") throw new Error("narrowing");
    expect(await conflictsWithOf(r.handle)).toBe(target.id);
    expect((await claimById(target.id)).superseded_at).toBeNull();
  });

  it("step 5 — an equal-or-stronger class in a CLEAN turn supersedes, at the REPLACEMENT's class", async () => {
    const target = await seedHead(PS, "Acme invoices are paid monthly", "agent_inferred");
    const r = await factWrite({
      op: { kind: "replace", targetHandle: target.handle, expectedRevision: 1 },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "superseded", revision: 2, sourceClass: "user_direct" });
    if (r.status !== "superseded") throw new Error("narrowing");
    expect((await claimById(target.id)).superseded_at).not.toBeNull();
    expect((await rowOf(r.handle)).supersedes).toBe(target.id);
    // A supersede is not a conflict: the successor points at nobody.
    expect(await conflictsWithOf(r.handle)).toBeNull();
  });

  it("step 7 — a superseding row never inherits the predecessor's class", async () => {
    // `owner_authored` is the dangerous direction: it and `user_direct` are the same
    // channel, so an inheriting writer would look right in every projection while signing
    // the agent's words with an authority only a person's own action can mint.
    const target = await seedHead(PS, "Acme invoices are paid monthly", "owner_authored");
    const r = await factWrite({
      op: { kind: "replace", targetHandle: target.handle, expectedRevision: 1 },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: clean(),
    });
    if (r.status !== "superseded") throw new Error(`expected superseded, got ${r.status}`);
    expect((await rowOf(r.handle)).source_class).toBe("user_direct");
    expect((await claimById(target.id)).source_class).toBe("owner_authored");
  });

  it("step 8 — expires_at is armed at insert by horizonFor, and is NULL for user_direct", async () => {
    // ASSERTED, not arranged: neither writer takes an `expires_at` parameter, so this is a
    // property of the insert and the only way in is the class.
    const inferred = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (inferred.status !== "created") throw new Error(`expected created, got ${inferred.status}`);
    const armed = (await rowOf(inferred.handle)).expires_at as Date;
    expect(armed).not.toBeNull();
    const days = (armed.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const stated = await factWrite({
      op: { kind: "create", scope: "user" },
      statement: "I prefer EUR",
      grounding: { kind: "current_user_quote", quote: "I prefer EUR for everything" },
      ctx: clean(),
    });
    if (stated.status !== "created") throw new Error(`expected created, got ${stated.status}`);
    // The person said it. A horizon on their own words would be the system quietly
    // forgetting what it was told.
    expect((await rowOf(stated.handle)).expires_at).toBeNull();
  });

  it("an invalid handle rejects the WHOLE mutation — a fact is never saved with its grounding dropped", async () => {
    const before = await claimCount(PS);
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "retrieved", handles: ["m9", "n4"] },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_handle");
    expect(r.said).toContain("m9");
    expect(r.said).toContain("n4");
    expect(await claimCount(PS)).toBe(before);
  });

  it("a valid handle among invalid ones does not rescue the write", async () => {
    // The half the case above cannot see: with one resolvable handle the "least-trusted
    // among them" fold has an answer, so a writer that skipped the unresolvable ones would
    // produce a class and a row — a fact stored with part of its grounding silently gone.
    const real = await seedHead(PS, "Acme invoices are paid monthly", "agent_inferred");
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "retrieved", handles: [real.handle, "m9"] },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_handle");
    expect(r.said).toContain("m9");
    expect(r.said).not.toContain(real.handle);
    expect(await claimCount(PS)).toBe(1);
  });

  it("does not tell the model WHICH clause failed (NEW-4) — the audit event does", async () => {
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The supplier ships on Fridays",
      grounding: { kind: "current_user_quote", quote: "please check this for me" },
      ctx: clean(),
    });
    // Located in the turn, outside quotes, long enough — clauses 1-3 hold and clause 4,
    // the tie between the statement and the quote, is the one that fails.
    expect(r.status).toBe("downgraded");
    if (r.status !== "downgraded") throw new Error("narrowing");
    expect(r.sourceClass).toBe("agent_inferred");
    expect(JSON.stringify(r)).not.toMatch(/failedClause|clause/i);
    const ev = await auditPayload(r.handle, "claim.create");
    expect(ev.failedClause).toBe(4);
  });

  it("step 1 — a retrieved write is capped at agent_inferred even when it is grounded on a manifest row", async () => {
    // The AGENT composed the sentence; grounding it on the person's own fact does not make
    // it the person's. `user_direct` is reachable only through the statement-to-quote tie.
    const source = await seedHead(PS, "Acme invoices are paid monthly", "user_direct");
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "retrieved", handles: [source.handle] },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "created", sourceClass: "agent_inferred" });
  });

  it("step 2 — a credential-shaped statement is sensitive whatever the caller asked, and lands owner_only", async () => {
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The deploy token is ghp16CkQ2fVbNq8sPzYw3TmXrLdA5eHjU9Ki",
      grounding: { kind: "agent_inference" },
      sensitive: false,
      ctx: clean(),
    });
    if (r.status !== "created") throw new Error(`expected created, got ${r.status}`);
    expect(r.promptAccess).toBe("owner_only");
    expect((await rowOf(r.handle)).sensitive).toBe(true);
  });

  it("step 6 — the topic resolves and the contains edge is written in the same transaction", async () => {
    const first = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "agent_inference" },
      topic: "Offices",
      ctx: clean(),
    });
    if (first.status !== "created") throw new Error(`expected created, got ${first.status}`);
    expect(first.said).toContain("NEW topic «Offices»");

    const claimId = claimIdOf(first.handle);
    const { rows: membership } = await q(`SELECT note_id FROM note_claims WHERE claim_id = $1`, [claimId]);
    expect(membership.length).toBe(1);
    // The §11.5 dual-write: the membership row and the edge are one transaction, so a
    // reader of either sees the same topic.
    const { rows: edges } = await q(
      `SELECT from_node_id FROM vault_edges WHERE to_node_id = $1 AND relation = 'contains' AND deleted_at IS NULL`,
      [claimId],
    );
    expect(edges.map((e) => e.from_node_id)).toEqual([membership[0].note_id]);

    // The same subject in different words folds onto the SAME topic rather than building a
    // parallel one beside it.
    const second = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office has three floors",
      grounding: { kind: "agent_inference" },
      topic: "  offices ",
      ctx: clean(),
    });
    if (second.status !== "created") throw new Error(`expected created, got ${second.status}`);
    expect(second.said).toContain("existing topic «Offices»");
    const { rows: both } = await q(`SELECT note_id FROM note_claims WHERE claim_id = $1`, [
      claimIdOf(second.handle),
    ]);
    expect(both[0].note_id).toBe(membership[0].note_id);
  });

  it("step 9 — a retired space gains nothing, and says so instead of throwing", async () => {
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [PS]);
    const r = await factWrite({
      op: { kind: "create", scope: "project" },
      statement: "The office moved to Lviv",
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("retired");
    expect(await claimCount(PS)).toBe(0);
  });

  it("step 5's rank agrees with the authority the database grants, derived from it", async () => {
    // THE PIN, and it calls the REAL comparison. Round 1 of this test compared the database
    // against a third hand-written copy of the map while `accessOf` stayed module-private,
    // so the one thing it claimed to catch was the one thing it could not see (review
    // MED-2). `mayOutrank` is `write-tools.ts`'s own exported function here, and the
    // expectation is DERIVED from `prompt_access` — no literal class→channel table.
    //
    // The channel is not the rank and this test does not say it is: it says the two must not
    // DISAGREE. Two classes the database puts on one channel carry one authority, so neither
    // may outrank the other; two it separates carry different authority, so the rank must be
    // strict in exactly one direction. That is the whole of the agreement, and all of it
    // comes off the rows.
    const channelOf: Record<string, string> = {};
    for (const cls of CLASSES) {
      const seeded = await seedHead(PS, `class probe ${cls}`, cls);
      // Seeded non-sensitive on purpose: `sensitive` collapses every class to `owner_only`,
      // which is the display bound step 5 deliberately does not rank on.
      channelOf[cls] = (await claimById(seeded.id)).prompt_access;
    }
    // The control: if every class came back on one channel, the pairwise assertions below
    // would all take the "same channel" arm and pass without testing an ordering at all.
    expect(new Set(Object.values(channelOf)).size).toBeGreaterThan(1);

    for (const a of CLASSES) {
      for (const b of CLASSES) {
        const same = channelOf[a] === channelOf[b];
        const label = `${a}(${channelOf[a]}) vs ${b}(${channelOf[b]})`;
        if (same) {
          expect(mayOutrank(a, b) && mayOutrank(b, a), label).toBe(true);
        } else {
          expect(mayOutrank(a, b) !== mayOutrank(b, a), label).toBe(true);
        }
      }
    }

    // DIRECTION, which no column can supply — which channel is the strongest is a product
    // decision, not a database fact — so it is pinned once, as the bound it comes from:
    // §10.1 bound 4, "an untrusted claim cannot supersede a trusted one". The trusted set is
    // read off the rows rather than listed: it is whatever the database admits to the
    // always-on prompt.
    const manifestClasses = CLASSES.filter((c) => channelOf[c] === "manifest");
    expect(manifestClasses.length).toBeGreaterThan(0);
    for (const trusted of manifestClasses) {
      expect(mayOutrank("untrusted_derived", trusted), trusted).toBe(false);
      expect(mayOutrank(trusted, "untrusted_derived"), trusted).toBe(true);
      // And the middle tier, for the same reason and in the same direction.
      for (const mid of CLASSES.filter((c) => channelOf[c] === "memory_search")) {
        expect(mayOutrank(mid, trusted), `${mid} -> ${trusted}`).toBe(false);
        expect(mayOutrank(trusted, mid), `${trusted} -> ${mid}`).toBe(true);
      }
    }
  });

  it("has no pending status and no approval anywhere in its surface", async () => {
    // Written as a LOOP rather than `expect(values).not.toContain(expect.stringMatching(…))`,
    // which cannot fail: `toContain` compares by identity, so an asymmetric matcher inside
    // it never matches and the assertion passes against any sentence at all.
    const offenders = Object.entries(SAID).filter(([, s]) => /confirm|approve|waiting|pending/i.test(s));
    expect(offenders).toEqual([]);
    expect(Object.keys(SAID)).not.toContain("pending");
    // The control: the regex does find the sentence the LEGACY tools return, so an empty
    // result above is a fact about these sentences and not about the pattern.
    expect(/confirm|approve|waiting|pending/i.test("Recorded, and waiting: saved facts are only added once the user confirms them")).toBe(true);
  });
});

/** The suite does not leave a claim behind after `afterEach`, which is what makes the live
 *  counts in the report readable. Kept as an assertion rather than as a comment, because a
 *  fixture that leaks is invisible until somebody reads the wrong number. */
run("memory_fact_write fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const { rows } = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(rows[0].c)).toBe(0);
  });
});
