import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * "Every subtype row is created in one transaction with its node row." Asserted at the
 * three writers rather than inferred from the foreign key, because the FK only tells you
 * that SOMETHING inserted a node — not that the writer did it inside the same transaction,
 * which is what makes a rolled-back claim leave no orphan node behind.
 */
import { db, pool } from "@/lib/db";
import { createClaim, forgetAllClaims, forgetClaim, updateClaim, type Actor } from "../claims";
import { deleteNode } from "../nodes";
import { getOrCreateTopicNote, DEFAULT_TOPIC_KEY } from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const P = "nodestest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`;
/** A second space, for the one failure `createClaim` can reach AFTER both of its
 *  inserts — see the atomicity test at the bottom. */
const SPACE_B = `${P}space-b`;
const NOTE_B = `${P}note-b`;
const ACTOR: Actor = { kind: "user", id: OWNER };
const FK_VIOLATION = "23503";
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const nodeOf = async (id: string) =>
  (await q(`SELECT kind, space_id, deleted_at FROM vault_nodes WHERE id = $1`, [id])).rows[0] ?? null;

const nodeCount = async (spaceId: string) =>
  (await q(`SELECT count(*)::int AS n FROM vault_nodes WHERE space_id = $1`, [spaceId])).rows[0].n as number;

/** The node half of a subtype row. Raw fixtures write the subtype row directly, so they
 *  own the node row too — the composite FK is what turned "every subtype row has a node"
 *  from a convention into a constraint. */
const seedNode = (id: string, spaceId: string, kind: "claim" | "note" | "source") =>
  q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, spaceId, kind]);

const edge = (id: string, from: string, to: string, relation: "contains" | "references") =>
  q(
    `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
     VALUES ($1,$2,$3,$4,$5,'{"kind":"system"}'::jsonb)`,
    [id, SPACE_A, from, to, relation],
  );

/** As TEXT, so identity is compared byte for byte: the driver parses `timestamp` to a
 *  millisecond-precision Date, and a re-timestamping mutant that lands in the same
 *  millisecond would compare equal as a Date. */
const deletedAt = async (table: "vault_nodes" | "vault_edges", id: string) =>
  (await q(`SELECT deleted_at::text AS t FROM ${table} WHERE id = $1`, [id])).rows[0]?.t as string | null;

/** A tombstone far enough in the past that an unguarded re-drive moves it by years
 *  rather than by microseconds — which is the only thing that makes the
 *  `deleted_at IS NULL` guards killable at all. */
const BACKDATED = "2020-01-01 00:00:00";

run("vault: a subtype row and its node row are one write", () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'nodes test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
      [OWNER, `${OWNER}@test.local`],
    );
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });
  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [SPACE_A, OWNER]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$1,$2)`, [SPACE_B, OWNER]);
    // Written by hand rather than through `getOrCreateTopicNote`: this note is only ever
    // a wrong address for a claim in SPACE_A, and the service would run its own fence and
    // lock for a row that never needs either. Its node is seeded here because the
    // composite FK below now requires one — which is why SPACE_B's count is a baseline
    // rather than a literal zero.
    await seedNode(NOTE_B, SPACE_B, "note");
    await q(`INSERT INTO vault_notes (id, space_id, title, kind, topic_key) VALUES ($1,$2,'Elsewhere','memory_topic',$3)`, [
      NOTE_B,
      SPACE_B,
      "elsewhere",
    ]);
  });

  it("createClaim writes a claim node", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "the office closes at six", origin: { kind: "test" } },
      ACTOR,
    );
    expect(await nodeOf(c.id)).toMatchObject({ kind: "claim", space_id: SPACE_A, deleted_at: null });
  });

  it("updateClaim's successor gets its own node", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "the office closes at six", origin: { kind: "test" } },
      ACTOR,
    );
    const upd = await updateClaim({
      claimId: c.id,
      expectedRevision: c.revision,
      patch: { statement: "the office closes at seven" },
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    // BOTH: the predecessor keeps its node (it is history, not a tombstone) and the
    // successor gets one of its own.
    expect(await nodeOf(c.id)).toMatchObject({ kind: "claim", deleted_at: null });
    expect(await nodeOf(upd.id)).toMatchObject({ kind: "claim", deleted_at: null });
  });

  it("getOrCreateTopicNote writes a note node, once", async () => {
    const a = await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    const b = await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    expect(b).toBe(a);
    expect(await nodeOf(a)).toMatchObject({ kind: "note", space_id: SPACE_A });
    const n = await q(`SELECT count(*)::int AS n FROM vault_nodes WHERE id = $1`, [a]);
    expect(n.rows[0].n).toBe(1);
  });

  it("mints no node when the retired-space fence refuses the write", async () => {
    // The fence throws AFTER nothing and BEFORE everything, so what this witnesses is
    // ORDER, not atomicity: move `insertNode` above `assertSpaceLive` and a retired space
    // starts collecting nodes. The transaction is not exercised at all — that is the test
    // below. Counting is the assertion, because the id is not observable from outside.
    const before = await nodeCount(SPACE_A);
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [SPACE_A]);
    await expect(
      createClaim({ spaceId: SPACE_A, statement: "written into a retired space", origin: { kind: "test" } }, ACTOR),
    ).rejects.toThrow(/retired/);
    expect(await nodeCount(SPACE_A)).toBe(before);
  });

  it("rolls the node row back when the claim write fails AFTER both inserts", async () => {
    // THE atomicity witness, and it needs a failure the fence cannot supply: a topic note
    // that belongs to another space is refused by `assertTopicInSpace`, which runs after
    // the node row and the claim row are both already written. So this is the test that
    // goes red if `createClaim`'s transaction is swapped for a bare pool handle — with two
    // autocommits the node survives its own claim, which is the orphan the whole co-write
    // exists to prevent and which no ordinary test can see.
    const before = await nodeCount(SPACE_A);
    const beforeB = await nodeCount(SPACE_B);
    await expect(
      createClaim(
        { spaceId: SPACE_A, statement: "filed under a stranger's topic", origin: { kind: "test" }, topicNoteId: NOTE_B },
        ACTOR,
      ),
    ).rejects.toThrow(/does not belong/);
    expect(await nodeCount(SPACE_A)).toBe(before);
    // And nothing landed in the other space either: the node carries SPACE_A, so a
    // surviving row would be counted above — this pins the second space at its baseline
    // so the assertion above cannot pass by the node having gone somewhere else.
    expect(await nodeCount(SPACE_B)).toBe(beforeB);
  });
});

run("vault: the subtype -> node composite FKs", () => {
  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [SPACE_A, OWNER]);
  });
  afterAll(cleanup);

  it("refuses a claim with no node row", async () => {
    await expect(
      q(
        `INSERT INTO vault_claims (id, space_id, statement, origin)
         VALUES ($1,$2,'a claim with no node','{}'::jsonb)`,
        [`${P}orphan-claim`, SPACE_A],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "vault_claim_node_fk" });
  });

  it("refuses a note with no node row", async () => {
    await expect(
      q(`INSERT INTO vault_notes (id, space_id, title) VALUES ($1,$2,'orphan')`, [`${P}orphan-note`, SPACE_A]),
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "vault_note_node_fk" });
  });

  it("refuses a knowledge source with no node row", async () => {
    await expect(
      q(
        `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by)
         VALUES ($1,$2,'orphan','{}'::jsonb,$3)`,
        [`${P}orphan-src`, SPACE_A, OWNER],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "knowledge_source_node_fk" });
  });

  it("refuses a claim whose node is in another space", async () => {
    // The composite FK carries the space. A node with the right id in the wrong space is
    // not a parent — that is the property, and it is the same one the edges rely on.
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      SPACE_B,
      `${P}proj`,
      OWNER,
    ]);
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}cross`, SPACE_B]);
    await expect(
      q(
        `INSERT INTO vault_claims (id, space_id, statement, origin)
         VALUES ($1,$2,'wrong space','{}'::jsonb)`,
        [`${P}cross`, SPACE_A],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "vault_claim_node_fk" });
  });
});

run("vault: the node inverses", () => {
  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [SPACE_A, OWNER]);
  });
  afterAll(cleanup);

  it("forgetClaim soft-deletes the claim's node and its live edges", async () => {
    // Round-2 N10: "forget this fact" and "forget everything" are the same user-facing act
    // and must not have two terminal states. One row and all rows do not deliberately differ.
    const topic = await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "reports go out on fridays", origin: { kind: "test" }, topicNoteId: topic },
      ACTOR,
    );
    // BOTH directions, because the cascade's `or` has two disjuncts and one seeded edge
    // kills only one of them. With the claim on the `to` side alone, dropping
    // `eq(vaultEdges.fromNodeId, nodeId)` leaves every test green — and that is the half
    // slice 3 produces first, when a `derived_from` edge points FROM a claim.
    await edge(`${P}e-to`, topic, c.id, "contains");
    await edge(`${P}e-from`, c.id, topic, "references");
    const res = await forgetClaim({
      claimId: c.id, expectedRevision: c.revision, allowedSpaceIds: [SPACE_A], actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    expect((await nodeOf(c.id))?.deleted_at).not.toBeNull();
    expect(await deletedAt("vault_edges", `${P}e-to`)).not.toBeNull();
    expect(await deletedAt("vault_edges", `${P}e-from`)).not.toBeNull();
    // The TOPIC survives: forgetting a fact is not forgetting where it was filed.
    expect((await nodeOf(topic))?.deleted_at).toBeNull();
  });

  it("forgetAllClaims soft-deletes every head's node", async () => {
    const a = await createClaim({ spaceId: SPACE_A, statement: "one", origin: { kind: "test" } }, ACTOR);
    const b = await createClaim({ spaceId: SPACE_A, statement: "two", origin: { kind: "test" } }, ACTOR);
    const { forgotten } = await forgetAllClaims(SPACE_A, ACTOR);
    expect(forgotten).toBe(2);
    expect((await nodeOf(a.id))?.deleted_at).not.toBeNull();
    expect((await nodeOf(b.id))?.deleted_at).not.toBeNull();
  });

  it("leaves a SUPERSEDED predecessor's node alive", async () => {
    // The control that makes the two above mean something: `superseded_at` and
    // `vault_nodes.deleted_at` are different flags with different readers, and a
    // deleteNode on every supersede would erase history the page still renders.
    const c = await createClaim({ spaceId: SPACE_A, statement: "before", origin: { kind: "test" } }, ACTOR);
    const upd = await updateClaim({
      claimId: c.id, expectedRevision: c.revision, patch: { statement: "after" },
      allowedSpaceIds: [SPACE_A], actor: ACTOR,
    });
    expect(upd.ok).toBe(true);
    expect((await nodeOf(c.id))?.deleted_at).toBeNull();
  });

  it("a re-driven deleteNode re-timestamps nothing", async () => {
    // The `deleted_at IS NULL` guards are what make the docstring's idempotency claim
    // true, and nothing else in the suite kills them: drop either guard and every other
    // test stays green. A second `forgetClaim` cannot be the vehicle — it is refused at
    // its OWN `superseded_at` guard and never reaches the node module — so the re-drive
    // is aimed at the exported inverse, which is where the guards live.
    //
    // The reachable harm is not hypothetical: teardown is re-driven from the worker
    // tick, and an unguarded second pass would leave every tombstone reading when
    // teardown last ran instead of when the memory was removed.
    const topic = await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "the lease renews in April", origin: { kind: "test" }, topicNoteId: topic },
      ACTOR,
    );
    await edge(`${P}e-idem`, topic, c.id, "contains");
    const res = await forgetClaim({
      claimId: c.id, expectedRevision: c.revision, allowedSpaceIds: [SPACE_A], actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    await q(`UPDATE vault_nodes SET deleted_at = $2 WHERE id = $1`, [c.id, BACKDATED]);
    await q(`UPDATE vault_edges SET deleted_at = $2 WHERE id = $1`, [`${P}e-idem`, BACKDATED]);

    await deleteNode(c.id, SPACE_A, db);

    expect(await deletedAt("vault_nodes", c.id)).toBe(BACKDATED);
    expect(await deletedAt("vault_edges", `${P}e-idem`)).toBe(BACKDATED);
  });
});
