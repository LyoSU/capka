import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The claims service exists for three things, none of which can be checked without
 * a real Postgres: the CAS step that serializes two concurrent supersedes on a row
 * lock; the two partial unique indexes that catch a fork; and atomicity of a move
 * inside SOMEONE ELSE'S transaction. An in-memory double would be testing its own
 * imagination about each of them.
 */
import { db, pool } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import type { Ex } from "../spaces";
import {
  createClaim,
  updateClaim,
  forgetClaim,
  attachEvidence,
  attachToTopic,
  confirmClaim,
  listHeadClaims,
  headBySlot,
  findCurrentHead,
  type Actor,
} from "../claims";
import { classify, ownerAuthored, HORIZON_DAYS } from "../grounding";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Fixture prefix: everything is cleaned up by one DELETE over the spaces (the
 *  cascade takes the claims with their nanoid ids, the notes, the attachments, the
 *  evidence and the audit rows). */
const P = "clmtest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`; // "my" space
const SPACE_B = `${P}space-b`; // someone else's: exercises authz
const NOTE_A = `${P}note-a`;
const NOTE_B = `${P}note-b`; // a topic in SPACE_B: exercises the space invariant
const ACTOR: Actor = { kind: "user", id: OWNER };

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** The node half of a subtype row. Raw fixtures write the subtype row directly, so they
 *  own the node row too — the composite FK is what turned "every subtype row has a node"
 *  from a convention into a constraint. */
const seedNode = (id: string, spaceId: string, kind: "claim" | "note" | "source") =>
  q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, spaceId, kind]);

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

const claimRow = async (id: string) => {
  const { rows } = await pool.query<{
    statement: string;
    slot_key: string | null;
    value: unknown;
    kind: string;
    origin: Record<string, unknown>;
    review_status: string;
    approved_at: Date | null;
    approved_by_user_id: string | null;
    sensitive: boolean;
    revision: number;
    supersedes: string | null;
    superseded_at: Date | null;
  }>(`SELECT * FROM vault_claims WHERE id = $1`, [id]);
  return rows[0];
};

/** A forked chain: two rows with the same supersedes. The partial unique
 *  `uniq_vclaims_one_successor` has to make that impossible — the test looks at the
 *  outcome, not at the index. */
const branchedChains = async (spaceId: string) => {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT supersedes FROM vault_claims
       WHERE space_id = $1 AND supersedes IS NOT NULL
       GROUP BY supersedes HAVING count(*) > 1
     ) branched`,
    [spaceId],
  );
  return Number(rows[0].n);
};

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'claims test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const fixtures = async () => {
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $2, $2)`, [SPACE_A, OWNER]);
  await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
    SPACE_B,
    `${P}proj`,
    OWNER,
  ]);
  await seedNode(NOTE_A, SPACE_A, "note");
  await q(`INSERT INTO vault_notes (id, space_id, title, kind) VALUES ($1, $2, 'Topic', 'memory_topic')`, [
    NOTE_A,
    SPACE_A,
  ]);
  await seedNode(NOTE_B, SPACE_B, "note");
  await q(`INSERT INTO vault_notes (id, space_id, title, kind) VALUES ($1, $2, 'Topic', 'memory_topic')`, [
    NOTE_B,
    SPACE_B,
  ]);
};

/** The claim fixture is created through the service, because its output is exactly
 *  what everything else takes as input. */
const seed = (over: Partial<Parameters<typeof createClaim>[0]> = {}) =>
  createClaim(
    {
      spaceId: SPACE_A,
      statement: "the initial fact",
      origin: { type: "chat" },
      // Before the spread, so a test that is ABOUT the class can still override it.
      sourceClass: testServerClass("owner_authored"),
      ...over,
    },
    ACTOR,
  );

/** A tx that throws exactly on the audit-event insert — that is, AFTER the
 *  successor row and the attachment move. A proxy rather than a spyOn on the
 *  handle: drizzle keeps internal fields under symbols, so only one method is
 *  swapped and everything else reaches the original. */
const failOnAuditInsert = <T extends object>(tx: T, boom: Error): T =>
  new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
      return (table: unknown) => {
        if (table === auditEvents) throw boom;
        return (value as (t: unknown) => unknown).call(target, table);
      };
    },
  });

run("vault claims", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(async () => {
    await cleanup();
    await fixtures();
  });

  it("createClaim writes the claim, the topic attachment and a claim.create event", async () => {
    const { id, revision } = await seed({
      statement: "Favourite coffee — filter",
      slotKey: "coffee",
      value: { drink: "filter" },
      sensitive: true,
      topicNoteId: NOTE_A,
    });

    expect(revision).toBe(1);
    const row = await claimRow(id);
    expect(row.statement).toBe("Favourite coffee — filter");
    expect(row.slot_key).toBe("coffee");
    expect(row.value).toEqual({ drink: "filter" });
    expect(row.origin).toEqual({ type: "chat" });
    // `unverified`, and there is no argument that could have asked for anything else:
    // `createClaim` no longer accepts its own authorization. Only `confirmClaim` moves
    // this column, and only the person's decision reaches it.
    expect(row.review_status).toBe("unverified");
    expect(row.sensitive).toBe(true);
    expect(row.revision).toBe(1);
    expect(row.supersedes).toBeNull();
    expect(row.superseded_at).toBeNull();

    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, id])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.create' AND subject_id = $2", [SPACE_A, id])).toBe(1);
    // A sensitive claim's text must not also live in the audit log.
    const { rows } = await pool.query<{ payload: unknown }>(`SELECT payload FROM audit_events WHERE subject_id = $1`, [id]);
    expect(JSON.stringify(rows[0].payload)).not.toContain("filter");
  });

  it("a topic from ANOTHER space is refused by all three write paths, not silently attached", async () => {
    // Both foreign keys are valid on their own, so `note_claims` happily accepts the
    // row and SPACE_B's topic starts counting a claim it may not even show. Neither
    // the schema nor a foreign key can express "same space", so the module that owns
    // the table has to.
    await expect(seed({ statement: "a foreign topic", topicNoteId: NOTE_B })).rejects.toThrow(NOTE_B);
    // createClaim runs in its own transaction, so the refusal takes the claim with it.
    expect(await count("vault_claims", "space_id = $1 AND statement = 'a foreign topic'", [SPACE_A])).toBe(0);

    const { id } = await seed();
    await expect(attachToTopic(id, NOTE_B)).rejects.toThrow(NOTE_B);
    expect(await count("note_claims", "note_id = $1", [NOTE_B])).toBe(0);

    // The successor's fallback topic is a caller-supplied note id too, and an
    // unguarded third write site means the invariant does not hold.
    await expect(
      updateClaim({
        claimId: id,
        expectedRevision: 1,
        patch: { statement: "still ours", topicNoteId: NOTE_B },
        sourceClass: testServerClass("owner_authored"),
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      }),
    ).rejects.toThrow(NOTE_B);
    expect(await count("note_claims", "note_id = $1", [NOTE_B])).toBe(0);
    // The whole supersede rolled back: the original is still the head at revision 1.
    expect((await claimRow(id)).superseded_at).toBeNull();

    // And the same-space topic still works, so the guard is a filter, not a wall.
    await attachToTopic(id, NOTE_A);
    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, id])).toBe(1);
  });

  it("supersede: the old row keeps its text, the new one carries supersedes and +1 revision", async () => {
    const { id: oldId } = await seed({
      statement: "Works in Kyiv",
      slotKey: "city",
      value: { city: "Kyiv" },
      sensitive: true,
      topicNoteId: NOTE_A,
    });
    // APPROVED first, and that is what makes the `review_status` assertion below a
    // control rather than a restatement of the column default. A predecessor left
    // `unverified` reads the same whether the successor inherited it or fell back to the
    // default, so the expectation passed identically before and after the rule changed —
    // which is exactly why nothing flagged it.
    expect(await confirmClaim(oldId, false, ACTOR)).toBe(true);

    const res = await updateClaim({
      claimId: oldId,
      expectedRevision: 1,
      patch: { statement: "Works in Lviv", value: { city: "Lviv" } },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.revision).toBe(2);

    // The predecessor's text is NEVER UPDATEd — history reads verbatim.
    const prev = await claimRow(oldId);
    expect(prev.statement).toBe("Works in Kyiv");
    expect(prev.superseded_at).not.toBeNull();
    expect(prev.revision).toBe(1);

    const next = await claimRow(res.id);
    expect(next.statement).toBe("Works in Lviv");
    expect(next.value).toEqual({ city: "Lviv" });
    expect(next.supersedes).toBe(oldId);
    expect(next.revision).toBe(2);
    expect(next.superseded_at).toBeNull();
    // origin and sensitive are copied from the predecessor; `review_status` is NOT, and
    // this patch is why: it rewrites the statement, so the successor holds words nobody
    // has read yet and is born `unverified` however approved its predecessor was. The
    // approval record goes with the status — a row reading `confirmed` with no approver
    // named is the one shape those two columns exist to prevent.
    expect(next.origin).toEqual({ type: "chat" });
    expect(next.sensitive).toBe(true);
    expect(next.review_status).toBe("unverified");
    expect(next.approved_at).toBeNull();
    expect(next.approved_by_user_id).toBeNull();
    // The slot was not patched — it is inherited, and the slot's active head is now
    // the successor.
    expect(next.slot_key).toBe("city");

    // The topic attachment moved: the old row no longer holds it, the new one does.
    expect(await count("note_claims", "claim_id = $1", [oldId])).toBe(0);
    expect(await count("note_claims", "note_id = $1 AND claim_id = $2", [NOTE_A, res.id])).toBe(1);

    expect(
      await count("audit_events", "space_id = $1 AND action = 'claim.supersede' AND subject_id = $2", [SPACE_A, oldId]),
    ).toBe(1);
  });

  it("a supersede that rewrites NO text keeps the approval instead of stranding the head", async () => {
    // The rule's width is the point. "A supersede must not carry approval across" was
    // argued from NEW text reaching the model unapproved; a patch that moves a topic
    // brings no new words, and demoting there is not a temporary quarantine — every
    // caller of `confirmClaim` needs a candidate row, this path creates none, and the
    // head would leave both the model projection and the person's own memory page with
    // no surface left to re-approve it from.
    const { id } = await seed({ statement: "Works in Kyiv", topicNoteId: NOTE_A });
    expect(await confirmClaim(id, false, ACTOR)).toBe(true);
    const approved = await claimRow(id);

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { origin: { type: "correction" } },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!res.ok) throw new Error("unreachable");

    const next = await claimRow(res.id);
    expect(next.statement).toBe("Works in Kyiv");
    expect(next.origin).toEqual({ type: "correction" });
    // The same words, so the same approval — and the approver travels with it.
    expect(next.review_status).toBe("confirmed");
    expect(next.approved_at).toEqual(approved.approved_at);
    expect(next.approved_by_user_id).toBe(OWNER);
    // And the event says what the row says, rather than asserting a demotion that did
    // not happen.
    const { rows } = await q(
      `SELECT payload->>'reviewStatus' AS s FROM audit_events
        WHERE action = 'claim.supersede' AND subject_id = $1`,
      [id],
    );
    expect(rows[0].s).toBe("confirmed");
  });

  it("a supersede that rewrites only the VALUE still demotes: the patch reached a column the model reads", async () => {
    // The condition is read off the RESULTING ROW, not off a list of patch field names —
    // so a patch that touches the model-facing text through any field is caught. `value`
    // is the one nobody would think to enumerate.
    const { id } = await seed({ statement: "Acme pays in 30 days", value: { days: 30 } });
    expect(await confirmClaim(id, false, ACTOR)).toBe(true);

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { value: { days: 60 } },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!res.ok) throw new Error("unreachable");
    expect((await claimRow(res.id)).review_status).toBe("unverified");
  });

  it("revision mismatch: zero trace — no successor, no event, no touch to the row", async () => {
    const { id } = await seed({ slotKey: "mismatch", topicNoteId: NOTE_A });

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 7,
      patch: { statement: "must not happen" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // The chain is alive and untouched, so the loser sees the current head.
    expect(res.current?.id).toBe(id);
    expect(res.current?.revision).toBe(1);

    const row = await claimRow(id);
    expect(row.superseded_at).toBeNull();
    expect(row.statement).toBe("the initial fact");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);
  });

  it("RACE update/update: exactly one ok and EXACTLY one active head", async () => {
    const { id } = await seed({ statement: "the start", slotKey: "race" });
    const attempt = (statement: string) =>
      updateClaim({
        claimId: id,
        expectedRevision: 1,
        patch: { statement },
        sourceClass: testServerClass("owner_authored"),
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      });

    // No queueing: both transactions start at once and are serialized solely by the
    // row lock in the CAS step.
    const settled = await Promise.allSettled([attempt("branch A"), attempt("branch B")]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    // The loser is not left silent: it sees the head the winner just installed.
    expect(loser && !loser.ok && loser.current?.revision).toBe(2);

    // The head is counted from the DATABASE, not from the returned values.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(1);
    expect(await branchedChains(SPACE_A)).toBe(0);
  });

  it("RACE update/forget: one winner, no fork", async () => {
    const { id } = await seed({ statement: "contested", slotKey: "race2" });

    const settled = await Promise.allSettled([
      updateClaim({
        claimId: id,
        expectedRevision: 1,
        patch: { statement: "updated" },
        sourceClass: testServerClass("owner_authored"),
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      }),
      forgetClaim({ claimId: id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    const [upd, forget] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));

    expect([upd?.ok, forget?.ok].filter(Boolean)).toHaveLength(1);
    const updateWon = upd?.ok === true;

    // update won → one head remains; forget won → none does.
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(updateWon ? 1 : 0);
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(updateWon ? 1 : 0);
    expect(await branchedChains(SPACE_A)).toBe(0);
    // Exactly one event per chain: the loser writes nothing.
    expect(await count("audit_events", "space_id = $1 AND action IN ('claim.supersede','claim.forget')", [SPACE_A])).toBe(1);
    // The only unscoped read in this file, and `undefined` is written out here on
    // purpose — which is why the argument is required: it can no longer be omitted.
    expect(await findCurrentHead(id, undefined)).toEqual(updateWon ? expect.objectContaining({ revision: 2 }) : null);
  });

  it("authz: another space yields {ok:false, current:null} with no text leak", async () => {
    const secret = "a secret from another space";
    const foreign = await createClaim(
      { spaceId: SPACE_B, statement: secret, slotKey: "secret", origin: {}, sourceClass: testServerClass("owner_authored") },
      ACTOR,
    );

    const upd = await updateClaim({
      claimId: foreign.id,
      expectedRevision: 1,
      patch: { statement: "an attempt" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    const forget = await forgetClaim({
      claimId: foreign.id,
      expectedRevision: 1,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });

    // Exactly the same answer as "the chain was ended by a forget": it does not even
    // reveal that the claim exists.
    expect(upd).toEqual({ ok: false, current: null });
    expect(forget).toEqual({ ok: false, current: null });
    expect(JSON.stringify([upd, forget])).not.toContain(secret);
    // A direct lookup under the other filter is silent too.
    expect(await findCurrentHead(foreign.id, [SPACE_A])).toBeNull();
    // ...but not under its own, or the test would be green on a broken lookup.
    expect((await findCurrentHead(foreign.id, [SPACE_B]))?.statement).toBe(secret);

    // An empty space list also means "nothing", never "everything".
    expect(await findCurrentHead(foreign.id, [])).toBeNull();

    // And nothing was touched.
    const row = await claimRow(foreign.id);
    expect(row.superseded_at).toBeNull();
    expect(await count("audit_events", "space_id = $1 AND action <> 'claim.create'", [SPACE_B])).toBe(0);
  });

  // Two call shapes, one result: `Ex` permits passing the module-level `db`
  // EXPLICITLY, and that is a pool, not a transaction. If the service opened its own
  // transaction only on a missing argument, a caller who passed `db` "for tidiness"
  // would quietly write four separate statements instead of one move.
  it.each([
    ["ex omitted", undefined],
    ["ex === db, i.e. the pool", db],
  ] as const)("atomicity (%s): a failure after the successor insert rolls back the WHOLE move", async (_label, passed) => {
    const { id } = await seed({ statement: "before the failure", slotKey: "atomic", topicNoteId: NOTE_A });

    const boom = new Error("failure after the successor");
    const realTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((async (cb: (tx: Ex) => Promise<unknown>) =>
      realTransaction((tx) => cb(failOnAuditInsert(tx, boom)))) as unknown as typeof db.transaction);

    try {
      await expect(
        updateClaim(
          {
            claimId: id,
            expectedRevision: 1,
            patch: { statement: "after the failure" },
            sourceClass: testServerClass("owner_authored"),
            allowedSpaceIds: [SPACE_A],
            actor: ACTOR,
          },
          passed,
        ),
      ).rejects.toBe(boom);
    } finally {
      spy.mockRestore();
    }

    // EVERYTHING rolled back: the CAS, the successor and the attachment move.
    const row = await claimRow(id);
    expect(row.superseded_at).toBeNull();
    expect(row.statement).toBe("before the failure");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
    // The service still works — the spy was removed, not left latched forever.
    const retry = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { statement: "after the rollback" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(retry.ok).toBe(true);
  });

  it("a 5-version chain: findCurrentHead finds the head from any link", async () => {
    const first = await seed({ statement: "version 1", slotKey: "chain" });
    const chain = [first.id];
    let cur = first;
    for (let i = 2; i <= 5; i++) {
      const res = await updateClaim({
        claimId: cur.id,
        expectedRevision: cur.revision,
        patch: { statement: `version ${i}` },
        sourceClass: testServerClass("owner_authored"),
        allowedSpaceIds: [SPACE_A],
        actor: ACTOR,
      });
      if (!res.ok) throw new Error(`link ${i} did not go through`);
      cur = { id: res.id, revision: res.revision, sensitive: false };
      chain.push(res.id);
    }
    expect(cur.revision).toBe(5);

    for (const link of chain) {
      const head = await findCurrentHead(link, [SPACE_A]);
      expect(head?.id).toBe(cur.id);
      expect(head?.revision).toBe(5);
      expect(head?.statement).toBe("version 5");
    }
    expect(await count("vault_claims", "space_id = $1 AND superseded_at IS NULL", [SPACE_A])).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(5);
  });

  it("forget: no successor, evidence and attachments stay, no head remains", async () => {
    const { id } = await seed({ statement: "forget me", slotKey: "forget", topicNoteId: NOTE_A });
    await attachEvidence(id, { relation: "supports", messageId: `${P}msg`, quoteSnapshot: "a quote" });

    const res = await forgetClaim({
      claimId: id,
      expectedRevision: 1,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(res).toEqual({ ok: true });

    const row = await claimRow(id);
    expect(row.superseded_at).not.toBeNull();
    expect(row.statement).toBe("forget me");
    expect(await count("vault_claims", "supersedes = $1", [id])).toBe(0);
    // History is intact: evidence and attachments stay on the inactive row.
    expect(await count("claim_evidence", "claim_id = $1 AND relation = 'supports'", [id])).toBe(1);
    expect(await count("note_claims", "claim_id = $1", [id])).toBe(1);

    expect(await findCurrentHead(id, [SPACE_A])).toBeNull();
    expect(await headBySlot(SPACE_A, "forget")).toBeNull();
    expect(await listHeadClaims(SPACE_A)).toEqual([]);

    // The event attests the deletion and carries no text of the fact — `audit_events`
    // survives `retireProjectSpace`, so a `reason` here would outlive the user's own
    // deletion of the project. `forgetClaim` no longer accepts one at all; this asserts
    // the payload a re-added field would have to break.
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE action = 'claim.forget' AND subject_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ revision: 1 });
  });

  it("update AFTER forget: {ok:false, current:null} and not one new row", async () => {
    const { id } = await seed({ statement: "already forgotten", slotKey: "gone" });
    expect(await forgetClaim({ claimId: id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({
      ok: true,
    });

    const res = await updateClaim({
      claimId: id,
      expectedRevision: 1,
      patch: { statement: "resurrection" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(res).toEqual({ ok: false, current: null });
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'claim.supersede'", [SPACE_A])).toBe(0);
  });

  it("listHeadClaims: heads only, ORDER BY recorded_at DESC, id — plus the filters", async () => {
    const c1 = await seed({ statement: "first", slotKey: "s1", topicNoteId: NOTE_A });
    await confirmClaim(c1.id, false, ACTOR);
    const c2 = await seed({ statement: "second", slotKey: "s2", topicNoteId: NOTE_A });
    const c3 = await seed({ statement: "third" });
    await confirmClaim(c3.id, false, ACTOR);
    const upd = await updateClaim({
      claimId: c2.id,
      expectedRevision: 1,
      patch: { statement: "second, version 2" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("unreachable");
    const sorted = (ids: string[]) => [...ids].sort();

    // Distinct recorded_at values: the first key is descending, so the successor (the
    // youngest) comes first and the oldest claim last.
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-01 00:00:00' WHERE id = $1`, [c1.id]);
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-02 00:00:00' WHERE id = $1`, [c3.id]);
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-03 00:00:00' WHERE id = $1`, [upd.id]);
    expect((await listHeadClaims(SPACE_A)).map((h) => h.id)).toEqual([upd.id, c3.id, c1.id]);

    // Equal recorded_at is the ordinary case when a migration writes a batch of
    // claims in one transaction. Then ONLY the second key holds the order, and
    // without it plan A's manifest would not be byte-stable. The control is computed
    // by Postgres itself: text sorting depends on the database collation, so a JS
    // `.sort()` here would be a different order, not the same one.
    await q(`UPDATE vault_claims SET recorded_at = '2026-01-01 00:00:00' WHERE space_id = $1`, [SPACE_A]);
    const { rows: byId } = await pool.query<{ id: string }>(
      `SELECT id FROM vault_claims WHERE space_id = $1 AND superseded_at IS NULL ORDER BY id`,
      [SPACE_A],
    );
    const heads = await listHeadClaims(SPACE_A);
    expect(heads.map((h) => h.id)).toEqual(byId.map((r) => r.id));
    expect(sorted(heads.map((h) => h.id))).toEqual(sorted([c1.id, c3.id, upd.id]));
    expect(heads.map((h) => h.statement)).toContain("second, version 2");

    expect((await listHeadClaims(SPACE_A, { slotKey: "s1" })).map((h) => h.id)).toEqual([c1.id]);
    const confirmed = await listHeadClaims(SPACE_A, { onlyConfirmed: true });
    expect(sorted(confirmed.map((h) => h.id))).toEqual(sorted([c1.id, c3.id]));
    // The attachment moved to the successor, so the topic filter sees exactly that.
    const byTopic = await listHeadClaims(SPACE_A, { topicNoteId: NOTE_A });
    expect(sorted(byTopic.map((h) => h.id))).toEqual(sorted([c1.id, upd.id]));
    // The other space is empty — the space filter does not leak.
    expect(await listHeadClaims(SPACE_B)).toEqual([]);

    const bySlot = await headBySlot(SPACE_A, "s2");
    expect(bySlot?.id).toBe(upd.id);
    expect(bySlot?.revision).toBe(2);
    expect(await headBySlot(SPACE_A, "no such slot")).toBeNull();
  });

  it("every function reads and writes THROUGH the ex it was given", async () => {
    // State BEFORE the transaction: three committed claims, one of them attached to a
    // topic. Every write inside the transaction has a committed row it could touch —
    // otherwise "nothing remained" proves nothing.
    const upd = await seed({ statement: "to be updated", slotKey: "ex-upd", topicNoteId: NOTE_A });
    const forget = await seed({ statement: "to be forgotten", slotKey: "ex-forget" });
    const evidence = await seed({ statement: "to carry evidence", slotKey: "ex-evidence" });

    const boom = new Error("rollback");
    const seen: Record<string, unknown> = {};
    const err = await db
      .transaction(async (tx) => {
        const created = await createClaim(
          {
            spaceId: SPACE_A,
            statement: "created inside the transaction",
            slotKey: "ex-created",
            origin: {},
            topicNoteId: NOTE_A,
            sourceClass: testServerClass("owner_authored"),
          },
          ACTOR,
          tx,
        );
        // Reads must go through ex as well: around it the uncommitted row is invisible,
        // and that would fail here rather than drift silently into Task 5.
        seen.bySlot = (await headBySlot(SPACE_A, "ex-created", tx))?.id;

        const superseded = await updateClaim(
          {
            claimId: upd.id,
            expectedRevision: 1,
            patch: { statement: "updated inside the transaction" },
            sourceClass: testServerClass("owner_authored"),
            allowedSpaceIds: [SPACE_A],
            actor: ACTOR,
          },
          tx,
        );
        if (!superseded.ok) throw new Error("the CAS should not have lost");
        seen.head = (await findCurrentHead(upd.id, [SPACE_A], tx))?.id;
        seen.expectedHead = superseded.id;

        await forgetClaim({ claimId: forget.id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR }, tx);
        await attachEvidence(evidence.id, { messageId: `${P}msg`, quoteSnapshot: "evidence" }, tx);

        seen.listed = (await listHeadClaims(SPACE_A, {}, tx)).map((h) => h.id).includes(forget.id);
        seen.createdId = created.id;
        throw boom;
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBe(boom);
    expect(seen.bySlot).toBe(seen.createdId);
    expect(seen.head).toBe(seen.expectedHead);
    expect(seen.listed).toBe(false);

    // No statement escaped to the module-level `db`: one that did would commit on its
    // own and survive the rollback. This is the only check that catches an ex → db
    // substitution.
    expect(await count("vault_claims", "space_id = $1", [SPACE_A])).toBe(3);
    expect(await count("vault_claims", "space_id = $1 AND supersedes IS NOT NULL", [SPACE_A])).toBe(0);
    expect(await count("vault_claims", "id = $1 AND superseded_at IS NULL", [upd.id])).toBe(1);
    expect(await count("vault_claims", "id = $1 AND superseded_at IS NULL", [forget.id])).toBe(1);
    expect(await count("note_claims", "note_id = $1", [NOTE_A])).toBe(1);
    expect(await count("note_claims", "claim_id = $1", [upd.id])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [evidence.id])).toBe(0);
    // The fixtures' three create events were committed before the transaction; not one
    // more should have been added inside it.
    expect(await count("audit_events", "space_id = $1", [SPACE_A])).toBe(3);
  });

  it("both writers screen the statement, so no caller can put a credential in unscreened", async () => {
    // `createClaim` and `updateClaim` are the only two statements that insert into
    // this table. The screen sat above them, at the candidate ledger, and the boot
    // migration walked past it by calling `createClaim` directly — the fourth time in
    // this feature that a rule placed at one entrance missed another. Placed here, a
    // writer that has not read any of this is covered anyway.
    const secret = "sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz";

    // Create: the flag comes back raised, not merely stored raised — a caller that
    // tracks what it asked for must not be tracking a value the row does not hold.
    const made = await seed({ statement: `the deploy key is ${secret}` });
    expect(made.sensitive).toBe(true);
    expect((await claimRow(made.id)).sensitive).toBe(true);

    // Supersede: a NEW row, and the only other way new text enters the table. Without
    // the screen here an ordinary claim could be rewritten into one carrying a
    // credential and stay manifest-eligible, since `sensitive` is otherwise inherited.
    const plain = await seed({ statement: "the deploy key is rotated every quarter" });
    expect(plain.sensitive).toBe(false);
    const upd = await updateClaim({
      claimId: plain.id,
      expectedRevision: plain.revision,
      patch: { statement: `the deploy key is now ${secret}` },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("expected the supersede to win the CAS");
    expect((await claimRow(upd.id)).sensitive).toBe(true);

    // An ordinary fact is untouched by either writer: this is a screen, not a blanket.
    const ordinary = await seed({ statement: "the client pays in hryvnia" });
    expect(ordinary.sensitive).toBe(false);
    expect((await claimRow(ordinary.id)).sensitive).toBe(false);
  });

  // One case per text-bearing column, so dropping any single column from the screen
  // expression kills exactly one of these and names itself. The statement column is
  // covered by the case above; these are the two that were unscreened.
  it.each([
    // `slot_key` is MODEL-FACING: memory_search prints it verbatim in every hit and
    // matches the query against it, so a credential in the key with an innocent
    // sentence was a non-sensitive claim handing the key back on every later search.
    ["slot_key", { statement: "the deploy key for staging", slotKey: "creds/sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz" }],
    // `value` is rendered nowhere today. That is exactly the reasoning that left the
    // quarantine filter off memory_search for a whole plan, so it is screened anyway.
    ["value", { statement: "the deploy key for staging", value: { token: "sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz" } }],
  ])("createClaim screens %s, not only the statement", async (_column, over) => {
    const made = await seed(over);
    expect(made.sensitive).toBe(true);
    expect((await claimRow(made.id)).sensitive).toBe(true);
  });

  it.each([
    // The systematic false positive that screening a slot key as PROSE produces: `/`
    // and `_` are in the catch-all's character class, so an ordinary deep key is 33
    // characters of pure match. It costs a fact hidden from the manifest, hidden from
    // search, and impossible for the agent to forget — so depth must not be evidence.
    ["an ordinary deep slot key", { slotKey: "suppliers/acme_corp/payment_terms" }],
    ["a deep slot key in a value", { value: { slot: "suppliers/acme_corp/payment_terms" } }],
    // And the entropy guess still holds within one segment, which is where a bare
    // unprefixed token would sit.
    ["a path with a long opaque leaf", { slotKey: "creds/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY" }],
  ])("%s", async (label, over) => {
    const made = await seed({ statement: "the supplier's terms", ...over });
    expect(made.sensitive).toBe(label === "a path with a long opaque leaf");
  });

  it.each([
    ["slot_key", { slotKey: "creds/sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz" }],
    ["value", { value: { token: "sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz" } }],
  ])("updateClaim screens %s on the successor it is about to write", async (_column, patch) => {
    // The supersede is the other half of the boundary: without the screen here an
    // ordinary claim could be rewritten to carry a credential in one of these columns
    // and stay manifest-eligible, since `sensitive` is otherwise inherited.
    const plain = await seed({ statement: "the deploy key is rotated every quarter" });
    expect(plain.sensitive).toBe(false);
    const upd = await updateClaim({
      claimId: plain.id,
      expectedRevision: plain.revision,
      patch,
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("expected the supersede to win the CAS");
    expect((await claimRow(upd.id)).sensitive).toBe(true);
  });

  it("a secret INHERITED into a successor is screened too, and the audit carries no slot key", async () => {
    // A supersede that touches neither column still rewrites both onto a new row, so
    // the inherited text goes through the screen — that is what upgrades a row written
    // before the screen read three columns. Simulated by writing the row underneath
    // the writers, which is the only way to obtain such a row now.
    const plain = await seed({ statement: "the deploy key is rotated every quarter", slotKey: "deploy/key" });
    await q(`UPDATE vault_claims SET slot_key = $2, sensitive = false WHERE id = $1`, [
      plain.id,
      "creds/sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz",
    ]);
    const upd = await updateClaim({
      claimId: plain.id,
      expectedRevision: plain.revision,
      patch: { statement: "the deploy key is rotated twice a year" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("expected the supersede to win the CAS");
    expect((await claimRow(upd.id)).sensitive).toBe(true);

    // And the slot key does not ride into the audit log, which outlives the space:
    // `retireProjectSpace` deletes the claims and keeps these events.
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE space_id = $1 AND action IN ('claim.create', 'claim.supersede')`,
      [SPACE_A],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.payload).not.toHaveProperty("slotKey");
  });

  it("sensitivity only ever rises: a stale caller cannot clear it", async () => {
    // Both writers take the flag from an argument, and a caller computes that
    // argument from a head it read EARLIER. Two of them reading the same
    // `sensitive=false` head, one confirming it sensitive and the other arriving
    // second with its stale `false`, put a claim a human closed back into the
    // manifest. The rule belongs to the write, not to every caller's memory of it.
    const claim = await seed({ statement: "a fact that turns out to be sensitive" });
    expect((await claimRow(claim.id)).sensitive).toBe(false);

    expect(await confirmClaim(claim.id, true, ACTOR)).toBe(true);
    expect((await claimRow(claim.id)).sensitive).toBe(true);

    // The stale duplicate, arriving second with everything it read before.
    expect(await confirmClaim(claim.id, false, ACTOR)).toBe(true);
    expect((await claimRow(claim.id)).sensitive).toBe(true);
    expect((await claimRow(claim.id)).review_status).toBe("confirmed");

    // And the same through a supersede, where `sensitive` is otherwise inherited
    // from the predecessor and a patch could simply overwrite it.
    const upd = await updateClaim({
      claimId: claim.id,
      expectedRevision: 1,
      patch: { statement: "reworded, and quietly no longer sensitive", sensitive: false },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!upd.ok) throw new Error("expected the supersede to win the CAS");
    expect((await claimRow(upd.id)).sensitive).toBe(true);
    // The event describes the successor, so it has to agree with the row.
    const { rows } = await pool.query<{ payload: { sensitive: boolean } }>(
      `SELECT payload FROM audit_events WHERE subject_id = $1 AND action = 'claim.supersede'`,
      [claim.id],
    );
    expect(rows[0].payload.sensitive).toBe(true);
  });

  it("stores the class the caller stated, on a create", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "stated class", origin: { kind: "test" }, sourceClass: testServerClass("agent_inferred") },
      ACTOR,
    );
    const r = await q(`SELECT source_class, prompt_access FROM vault_claims WHERE id = $1`, [c.id]);
    expect(r.rows[0]).toMatchObject({ source_class: "agent_inferred", prompt_access: "memory_search" });
  });

  it("stores the REPLACEMENT's class on a supersede, never the predecessor's", async () => {
    // The docstring says fields not listed are inherited from the predecessor, so with
    // NOT NULL and no default the likely implementer choice is inheritance — and an
    // agent-driven supersede would then carry legacy_confirmed/manifest across text the
    // agent wrote. That is the authority-laundering bound defeated by a default nobody
    // chose, which is why sourceClass sits OUTSIDE `patch`.
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "before", origin: { kind: "test" }, sourceClass: testServerClass("owner_authored") },
      ACTOR,
    );
    const upd = await updateClaim({
      claimId: c.id,
      expectedRevision: c.revision,
      patch: { statement: "after" },
      sourceClass: testServerClass("agent_inferred"),
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    const rows = await q(`SELECT id, source_class, prompt_access FROM vault_claims WHERE id = ANY($1)`, [
      [c.id, upd.id],
    ]);
    const by = Object.fromEntries(rows.rows.map((r: { id: string }) => [r.id, r]));
    expect(by[c.id]).toMatchObject({ source_class: "owner_authored" });
    expect(by[upd.id]).toMatchObject({ source_class: "agent_inferred", prompt_access: "memory_search" });
  });

  it("writes a normalized_hash on both inserts, folded the way norm folds", async () => {
    const a = await createClaim(
      { spaceId: SPACE_A, statement: "  Reports  go OUT on Fridays ", value: { day: "fri" },
        origin: { kind: "test" }, sourceClass: testServerClass("user_direct") },
      ACTOR,
    );
    const b = await createClaim(
      { spaceId: SPACE_A, statement: "reports go out on fridays", value: { day: "fri" },
        origin: { kind: "test" }, sourceClass: testServerClass("user_direct") },
      ACTOR,
    );
    const r = await q(`SELECT id, normalized_hash FROM vault_claims WHERE id = ANY($1)`, [[a.id, b.id]]);
    const hashes = r.rows.map((x: { normalized_hash: string }) => x.normalized_hash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    // Same normalized words and the same value collapse to one key — that IS the dedup
    // key, and a key that varied with whitespace would answer "known" almost never.
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("gives two objects with the same members but different key order one hash", async () => {
    // JSON.stringify is insertion-ordered, so without a sorted canonicalizer two writers
    // that built the same value differently would produce two keys for one fact — and the
    // hash goes under an index, so it must not change once chosen.
    const a = await createClaim(
      { spaceId: SPACE_A, statement: "same fact", value: { a: 1, b: 2 },
        origin: { kind: "test" }, sourceClass: testServerClass("user_direct") },
      ACTOR,
    );
    const b = await createClaim(
      { spaceId: SPACE_A, statement: "same fact", value: { b: 2, a: 1 },
        origin: { kind: "test" }, sourceClass: testServerClass("user_direct") },
      ACTOR,
    );
    const r = await q(`SELECT id, normalized_hash FROM vault_claims WHERE id = ANY($1)`, [[a.id, b.id]]);
    const [h1, h2] = r.rows.map((x: { normalized_hash: string }) => x.normalized_hash);
    expect(h1).toBe(h2);
  });

  it("arms expires_at inside the writer, from the class it is about to store", async () => {
    // The killing test the arming did not have: deleting either `expiresAt:
    // horizonFor(...)` line from `claims.ts` left the whole suite green, so "at insert, by
    // the writer, not by a trigger and not by a backfill" rested on inspection alone.
    //
    // The class comes out of `classify`, not out of `testServerClass`: the arming is a
    // property of the writer/class PAIR, and a fixture-minted class would witness the
    // column but not the path a real agent write takes to it.
    const inferred = classify(
      { kind: "agent_inference" },
      { statement: "reports ship on the first Monday", userTurnText: "", untrustedIngressSeen: false },
    );
    expect(inferred.sourceClass).toBe("agent_inferred");

    const armed = await seed({ statement: "reports ship on the first Monday", sourceClass: inferred.sourceClass });
    const never = await seed({ statement: "the person stated this themselves", sourceClass: ownerAuthored() });

    const horizons = await q(`SELECT id, expires_at FROM vault_claims WHERE id = ANY($1)`, [[armed.id, never.id]]);
    const by = Object.fromEntries(
      horizons.rows.map((r: { id: string; expires_at: Date | null }) => [r.id, r.expires_at]),
    );
    // The mirror half, and it is the one that fails if a writer ever arms unconditionally:
    // the person said it, and a horizon on their own words is the system quietly
    // forgetting what it was told.
    expect(by[never.id]).toBeNull();
    // A WINDOW, not an equality: `horizonFor` reads the clock, so the honest assertion is
    // the one a 90-day horizon passes and a 30- or 365-day one fails.
    expect(by[armed.id]).not.toBeNull();
    const days = (by[armed.id]!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(HORIZON_DAYS - 1);
    expect(days).toBeLessThan(HORIZON_DAYS + 1);

    // And a supersede RE-ARMS from the successor's own class rather than inheriting the
    // predecessor's null — the second `horizonFor` call site, which the create case above
    // cannot reach.
    const res = await updateClaim({
      claimId: never.id,
      expectedRevision: 1,
      patch: { statement: "the agent restated it" },
      sourceClass: inferred.sourceClass,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    if (!res.ok) throw new Error("unreachable");
    const successor = await q(`SELECT expires_at FROM vault_claims WHERE id = $1`, [res.id]);
    expect(successor.rows[0].expires_at).not.toBeNull();
  });
});
