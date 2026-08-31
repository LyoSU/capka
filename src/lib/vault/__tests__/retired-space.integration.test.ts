import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The lifecycle fence: nothing writes into a space the user already deleted.
 *
 * Post-turn extraction deliberately OUTLIVES its task (it runs after the reply is
 * delivered), while project deletion uses task activity as its liveness signal — so
 * the turn is `completed`, the delete is allowed, and an auxiliary model call that
 * takes seconds returns into a space that no longer exists for the user. Nothing is
 * mocked here, `retireProjectSpace` least of all: a stubbed retire would fix the
 * interleaving by hand and the test would then be checking an assumption about the
 * race instead of the race.
 */
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { vaultClaims } from "@/lib/db/schema";
import { createClaim, updateClaim, type Actor } from "../claims";
import { confirmCandidate, proposeCandidate } from "../candidates";
import { extractCandidates } from "../extract";
import { getOrCreateSpace, retireProjectSpace } from "../spaces";
import { DEFAULT_TOPIC_KEY, getOrCreateTopicNote } from "../topics";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix, so cleanup is one LIKE per table. Space ids
 *  are minted inside `getOrCreateSpace`, so those are caught by owner_user_id. */
const P = "retiredtest-";
const OWNER = `${P}owner`;
const MSG = `${P}msg`;
const TASK = `${P}task`;
const PROJ = `${P}proj`;

const actor: Actor = { kind: "agent" };

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

/** What the space holds, in one shot: the fence is about a fact ARRIVING, and a fact
 *  arrives as a claim, a candidate awaiting review, or the topic note either of them
 *  would be filed under. Asserting only on claims would pass while the review queue
 *  quietly refilled. */
const contents = async (spaceId: string) => ({
  claims: await count("vault_claims", "space_id = $1", [spaceId]),
  candidates: await count("memory_candidates", "space_id = $1", [spaceId]),
  notes: await count("vault_notes", "space_id = $1", [spaceId]),
});

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'retired space test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

/** A deferred, so a transaction can be held open across an await in the test body. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * Run `body` while a transaction is held open, and release it whatever happens.
 *
 * The `finally` is the whole point. Every test below holds a transaction that owns the
 * space row, so an assertion thrown INSIDE that window would leave the transaction open
 * forever — and then `beforeEach`'s `DELETE FROM spaces` blocks on the lock for every
 * remaining test in the file. One real failure reported itself as nine, eight of them
 * an unreadable timeout in `beforeEach`, which is precisely the shape that sends an
 * hour somewhere useless. Assertions therefore go AFTER this returns, never inside it.
 */
const whileHolding = async <T>(
  hold: (ready: () => void, release: Promise<void>) => Promise<void>,
  body: () => Promise<T>,
): Promise<T> => {
  const ready = deferred();
  const release = deferred();
  const held = hold(ready.resolve, release.promise);
  // Racing `held` too: a hold that fails before it signals would otherwise hang here.
  await Promise.race([ready.promise, held]);
  try {
    return await body();
  } finally {
    release.resolve();
    await held;
  }
};

const cleanup = () => q(`DELETE FROM spaces WHERE owner_user_id = $1`, [OWNER]);

run("vault: writes into a retired space", () => {
  beforeAll(() => mkUser(OWNER));
  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });
  beforeEach(cleanup);

  const spaces = async () => ({
    userSpaceId: await getOrCreateSpace({ type: "user", refId: OWNER }),
    projectSpaceId: await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER }),
  });

  it("an extraction that returns AFTER the project was deleted writes nothing", async () => {
    const { userSpaceId, projectSpaceId } = await spaces();
    const generating = deferred();

    // The real product path: the turn has answered, the aux model is still generating,
    // and the user deletes the project in that window.
    const extraction = extractCandidates({
      userSpaceId,
      projectSpaceId,
      messageId: MSG,
      taskId: TASK,
      userText: "we pay our suppliers in euros",
      assistantText: "noted",
      generate: async () => {
        await generating.promise;
        return {
          text: JSON.stringify([{ statement: "we pay our suppliers in euros", from: "user", scope: "project" }]),
          finishReason: "stop",
        };
      },
    });

    await retireProjectSpace(PROJ);
    generating.resolve();
    // Extraction never throws into its caller — it runs after the turn already
    // succeeded — so the assertion has to be about the rows, not about a rejection.
    await expect(extraction).resolves.toBeUndefined();

    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("a write already in flight BLOCKS on the retire and then refuses", async () => {
    // The window at its narrowest: the retire is uncommitted and holding the space
    // row, and the proposal arrives inside it.
    //
    // The `blocked` assertion below is NOT what proves the lock — an insert into the
    // space blocks on the foreign key's own row lock anyway, so it is green either way.
    // What proves it is the OUTCOME: with a locking read the proposal waits, re-reads
    // the committed row and returns `retired` cleanly. With a plain read it takes its
    // own older snapshot, passes the fence, writes the candidate — and only the next
    // statement, on a fresh READ COMMITTED snapshot, notices and throws, which reaches
    // extraction as a logged error instead of a turn that simply arrived late.
    const { projectSpaceId } = await spaces();
    const { outcome, propose } = await whileHolding(
      async (ready, release) => {
        await db.transaction(async (tx) => {
          await retireProjectSpace(PROJ, tx);
          ready();
          await release;
        });
      },
      async () => {
        const propose = proposeCandidate({
          idempotencyKey: `${P}inflight`,
          spaceId: projectSpaceId,
          statement: "invoices are approved by the head of finance",
          provenance: { kind: "user_direct", messageId: MSG },
        });
        return {
          propose,
          outcome: await Promise.race([
            propose.then(() => "done" as const),
            new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
          ]),
        };
      },
    );
    expect(outcome).toBe("blocked");
    expect(await propose).toEqual({ state: "retired" });
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("the retire takes the space row BEFORE it deletes, not after", async () => {
    // The fence's first branch — "a writer that gets FOR SHARE first commits into a
    // still-live space, and the retire queued behind it then deletes what it wrote" —
    // is only true because `retireProjectSpace` takes its lock as its FIRST statement.
    // Nothing else pins that. Move the `.for("update")` below the deletes, or drop it,
    // and the DELETE runs on a snapshot that cannot see the uncommitted claim, the lock
    // is then taken with nothing left to do, and the claim survives into a space the
    // user deleted — the original defect, restored in full, with every other test in
    // this file still green.
    const { projectSpaceId } = await spaces();
    let retire!: Promise<void>;
    const outcome = await whileHolding(
      async (ready, release) => {
        await db.transaction(async (tx) => {
          await createClaim(
            { spaceId: projectSpaceId, statement: "the deposit is 30 percent", origin: {}, sourceClass: testServerClass("owner_authored") },
            actor,
            tx,
          );
          ready();
          await release;
        });
      },
      async () => {
        retire = retireProjectSpace(PROJ);
        return Promise.race([
          retire.then(() => "done" as const),
          new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
        ]);
      },
    );
    await retire;
    // Lock first: the retire cannot get past the writer at all. Lock last: the deletes
    // sail through the writer's invisible row and this reads "done".
    expect(outcome).toBe("blocked");
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("a PENDING proposal in flight is refused — the path where a row would SURVIVE", async () => {
    // The claim path carries a second statement that catches a stale fence read on its
    // own: `createClaim` throws and takes the transaction with it, so nothing durable
    // escapes even without the lock. A pending proposal has no such statement — it
    // writes its candidate row and COMMITS. So this is the shape where the locking read
    // is the only thing standing between a deleted project and a durable row, and it is
    // the one the mutation has to be run against.
    const { projectSpaceId } = await spaces();
    const { outcome, propose } = await whileHolding(
      async (ready, release) => {
        await db.transaction(async (tx) => {
          await retireProjectSpace(PROJ, tx);
          ready();
          await release;
        });
      },
      async () => {
        const propose = proposeCandidate({
          idempotencyKey: `${P}inflight-pending`,
          spaceId: projectSpaceId,
          // Not the user's own words, so the ledger gates it to `pending` and no claim
          // is ever attempted.
          statement: "the supplier raised prices in March",
          provenance: { kind: "derived", messageId: MSG },
        });
        return {
          propose,
          outcome: await Promise.race([
            propose.then(() => "done" as const),
            new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
          ]),
        };
      },
    );
    expect(outcome).toBe("blocked");
    expect(await propose).toEqual({ state: "retired" });
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("getOrCreateTopicNote refuses to open a topic in a retired space", async () => {
    // The fourth entrance, and a real one: `migrateMemoryDocs` creates the topic note
    // BEFORE the first claim, so a bullet-less document would commit an empty topic
    // into a retired space without ever reaching the claim fence.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    await expect(getOrCreateTopicNote(projectSpaceId, DEFAULT_TOPIC_KEY)).rejects.toThrow(/retired/i);
    expect(await count("vault_notes", "space_id = $1", [projectSpaceId])).toBe(0);
  });

  it("a PENDING proposal leaves no candidate row either", async () => {
    // The claim fence cannot cover this one: a proposal that is not the user's own
    // words never reaches `createClaim` at all — it stops at a candidate row, which is
    // memory the user would meet in the review queue with the statement in full. So
    // this is the case that proves the ledger holds its own bound rather than
    // inheriting one from claims.ts.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const res = await proposeCandidate({
      idempotencyKey: `${P}pending`,
      spaceId: projectSpaceId,
      statement: "the supplier raised prices in March",
      provenance: { kind: "derived", messageId: MSG },
    });
    expect(res).toEqual({ state: "retired" });
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
    // And no audit event: a refused proposal is not a decision the space records — the
    // space is closed, and `space.retire` is the last thing written into it.
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.propose'", [projectSpaceId])).toBe(0);
  });

  it("createClaim refuses to open a chain in a retired space", async () => {
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    await expect(
      createClaim(
        {
          spaceId: projectSpaceId,
          statement: "the office moves in March",
          origin: { kind: "user_direct" },
          sourceClass: testServerClass("owner_authored"),
        },
        actor,
      ),
    ).rejects.toThrow(/retired/i);
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("updateClaim refuses to add a successor in a retired space", async () => {
    // A claim that outlived the retire is not hypothetical: a supersede committing
    // just after the retire's DELETE took its snapshot leaves the SUCCESSOR behind,
    // which is the very shape the fence exists to stop from happening twice.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const claimId = `${P}survivor`;
    await seedNode(claimId, projectSpaceId, "claim");
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, source_class)
       VALUES ($1, $2, 'a fact', '{}'::jsonb, 'agent_inferred')`,
      [claimId, projectSpaceId],
    );

    await expect(
      updateClaim({
        claimId,
        expectedRevision: 1,
        patch: { statement: "a corrected fact" },
        sourceClass: testServerClass("owner_authored"),
        allowedSpaceIds: [projectSpaceId],
        actor,
      }),
    ).rejects.toThrow(/retired/i);

    // The whole move rolled back: the predecessor is still the head, so a refused
    // update is not a silent forget.
    const [head] = await db
      .select({ supersededAt: vaultClaims.supersededAt })
      .from(vaultClaims)
      .where(and(eq(vaultClaims.id, claimId), eq(vaultClaims.spaceId, projectSpaceId)));
    expect(head?.supersededAt).toBeNull();
    expect(await count("vault_claims", "space_id = $1", [projectSpaceId])).toBe(1);
  });

  it("confirmCandidate refuses a candidate whose space was retired", async () => {
    // The fence `confirmCandidate`'s own docstring promised its first caller. The MERGE
    // branch is what needed it: `createClaim`/`updateClaim` fence themselves, so the
    // supersede and create paths were always refused — but a merge writes
    // `confirmClaim` and a `candidate.confirm` audit event, and the event SURVIVES the
    // retire's teardown. A fact the user deleted with their project would leave a
    // record of being confirmed afterwards, in a space that no longer exists.
    //
    // Both rows are inserted AFTER the retire, because the retire deletes them: the
    // race this stands in for is a confirmation already in flight when the project goes.
    const { projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const claimId = `${P}retired-head`;
    await seedNode(claimId, projectSpaceId, "claim");
    await q(
      `INSERT INTO vault_claims (id, space_id, statement, origin, review_status, source_class)
       VALUES ($1, $2, 'the office moves in March', '{}'::jsonb, 'unverified', 'agent_inferred')`,
      [claimId, projectSpaceId],
    );
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, policy_state)
       VALUES ($1, $1, $2, 'the office moves in March', '{"kind":"derived"}'::jsonb, 'pending')`,
      [`${P}retired-cand`, projectSpaceId],
    );

    const res = await confirmCandidate({
      candidateId: `${P}retired-cand`,
      allowedSpaceIds: [projectSpaceId],
      actor: { kind: "user", id: OWNER },
    });

    expect(res).toEqual({ ok: false, reason: "not_found" });
    // Nothing moved, in any of the three places a confirm would have touched.
    expect(await count("memory_candidates", "id = $1 AND resolved_at IS NULL", [`${P}retired-cand`])).toBe(1);
    expect(await count("vault_claims", "id = $1 AND review_status = 'unverified'", [claimId])).toBe(1);
    expect(await count("audit_events", "space_id = $1 AND action = 'candidate.confirm'", [projectSpaceId])).toBe(0);
  });

  it("a LIVE space still takes a confirm", async () => {
    // The control for the fence above: one that refused everything would pass it.
    const { userSpaceId } = await spaces();
    await getOrCreateTopicNote(userSpaceId, DEFAULT_TOPIC_KEY);
    const proposed = await proposeCandidate({
      idempotencyKey: `${P}live-confirm`,
      spaceId: userSpaceId,
      statement: "the office moves in March",
      provenance: { kind: "derived" },
    });
    if (proposed.state !== "pending") throw new Error(`expected pending, got ${proposed.state}`);
    const res = await confirmCandidate({
      candidateId: proposed.candidateId,
      allowedSpaceIds: [userSpaceId],
      actor: { kind: "user", id: OWNER },
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("a LIVE space still takes all three writes", async () => {
    // The control: a fence that refused everything would pass every assertion above.
    const { userSpaceId, projectSpaceId } = await spaces();
    const proposed = await proposeCandidate({
      idempotencyKey: `${P}live`,
      spaceId: projectSpaceId,
      statement: "we pay our suppliers in euros",
      provenance: { kind: "user_direct", messageId: MSG },
    });
    // `pending`, not `auto_active`: nothing the model proposes enters memory without a
    // person. The control this test provides is that the write HAPPENED at all — a
    // fence that refused everything would answer `retired`.
    expect(proposed.state).toBe("pending");

    const created = await createClaim(
      { spaceId: userSpaceId, statement: "works in procurement", origin: {}, sourceClass: testServerClass("owner_authored") },
      actor,
    );
    const updated = await updateClaim({
      claimId: created.id,
      expectedRevision: created.revision,
      patch: { statement: "works in procurement, Kyiv office" },
      sourceClass: testServerClass("owner_authored"),
      allowedSpaceIds: [userSpaceId],
      actor,
    });
    expect(updated.ok).toBe(true);
  });

  it("retiring the PROJECT space leaves the user's own space writable", async () => {
    // Deleting a project deletes that project's memory, not the person's — an
    // over-broad fence would take the user space with it, and the same turn's
    // user-scoped facts would vanish for good.
    const { userSpaceId, projectSpaceId } = await spaces();
    await retireProjectSpace(PROJ);
    const generating = deferred();
    const extraction = extractCandidates({
      userSpaceId,
      projectSpaceId,
      messageId: MSG,
      taskId: TASK,
      userText: "I work in procurement and we pay our suppliers in euros",
      assistantText: "noted",
      generate: async () => {
        await generating.promise;
        return {
          text: JSON.stringify([
            { statement: "works in procurement", from: "user", scope: "user" },
            { statement: "we pay our suppliers in euros", from: "user", scope: "project" },
          ]),
          finishReason: "stop",
        };
      },
    });
    generating.resolve();
    await extraction;

    // The user-scoped fact was recorded — as a candidate, which is what extraction
    // produces now — while the retired project space took nothing at all.
    expect(await count("memory_candidates", "space_id = $1", [userSpaceId])).toBe(1);
    expect(await count("vault_claims", "space_id = $1", [userSpaceId])).toBe(0);
    expect(await contents(projectSpaceId)).toEqual({ claims: 0, candidates: 0, notes: 0 });
  });

  it("leaves zero LIVE nodes and zero live edges for a retired space", async () => {
    // Migration step 11.10, under Ruling 10. Claims and notes are hard-DELETEd by this
    // function while SOURCES are soft-deleted, so the node rows are soft-deleted too: a
    // hard node delete would raise 23503 on knowledge_source_node_fk against the source
    // rows that deliberately survive, and abort a teardown that is re-driven forever.
    //
    // The source fixture is the point of this test. Without it the FK path is never
    // exercised and the same hole reopens in slice 3 the moment a source writer appears.
    const { projectSpaceId } = await spaces();
    const topic = await getOrCreateTopicNote(projectSpaceId, DEFAULT_TOPIC_KEY);
    const c = await createClaim(
      { spaceId: projectSpaceId, statement: "project fact", origin: { kind: "test" }, topicNoteId: topic, sourceClass: testServerClass("owner_authored") },
      actor,
    );
    const src = `${P}retire-src`;
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, 'source')`, [src, projectSpaceId]);
    await q(
      `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by)
       VALUES ($1, $2, 'a document', '{"type":"upload"}'::jsonb, $3)`,
      [src, projectSpaceId, OWNER],
    );
    await q(
      `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
       VALUES ($1,$2,$3,$4,'contains','{"kind":"system"}'::jsonb)`,
      [`${P}e-retire`, projectSpaceId, topic, c.id],
    );

    await retireProjectSpace(PROJ);

    // LIVE, not surviving: the node rows stay as tombstones (their source row does too),
    // and what must be zero is what any reader can still reach.
    expect(await count("vault_nodes", "space_id = $1 AND deleted_at IS NULL", [projectSpaceId])).toBe(0);
    expect(await count("vault_edges", "space_id = $1 AND deleted_at IS NULL", [projectSpaceId])).toBe(0);
    expect(await count("vault_search_documents", "space_id = $1", [projectSpaceId])).toBe(0);
    // The source's node is soft-deleted BESIDE its soft-deleted source row, so the two
    // halves of one entity are in the same state.
    const srcNode = await q(`SELECT deleted_at FROM vault_nodes WHERE id = $1`, [src]);
    expect(srcNode.rows[0].deleted_at).not.toBeNull();
  });

  it("a re-driven retire re-timestamps no tombstone", async () => {
    // Teardown IS re-driven, from the worker tick, so the `deleted_at IS NULL` guards in
    // `deleteSpaceNodes` are load-bearing: without them a second pass moves every node's
    // and edge's tombstone forward, and the row then records when teardown last ran
    // rather than when the user deleted the project — the same failure the
    // `isNull(spaces.retiredAt)` guard already prevents for the space row itself.
    //
    // Back-dating between the two passes is what makes this killable. Both writes stamp
    // `new Date()`, so two retires a millisecond apart would compare equal with the
    // guards removed; against a 2020 tombstone an unguarded re-drive moves by years.
    const { projectSpaceId } = await spaces();
    const topic = await getOrCreateTopicNote(projectSpaceId, DEFAULT_TOPIC_KEY);
    const c = await createClaim(
      { spaceId: projectSpaceId, statement: "the lease renews in April", origin: { kind: "test" }, topicNoteId: topic, sourceClass: testServerClass("owner_authored") },
      actor,
    );
    await q(
      `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
       VALUES ($1,$2,$3,$4,'contains','{"kind":"system"}'::jsonb)`,
      [`${P}e-redrive`, projectSpaceId, topic, c.id],
    );

    await retireProjectSpace(PROJ);
    const backdated = "2020-01-01 00:00:00";
    await q(`UPDATE vault_nodes SET deleted_at = $2 WHERE space_id = $1`, [projectSpaceId, backdated]);
    await q(`UPDATE vault_edges SET deleted_at = $2 WHERE space_id = $1`, [projectSpaceId, backdated]);
    // Not a vacuous comparison: the first pass really did tombstone rows to compare.
    expect(await count("vault_nodes", "space_id = $1", [projectSpaceId])).toBe(2);
    expect(await count("vault_edges", "space_id = $1", [projectSpaceId])).toBe(1);

    await retireProjectSpace(PROJ);

    expect(await count("vault_nodes", "space_id = $1 AND deleted_at <> $2", [projectSpaceId, backdated])).toBe(0);
    expect(await count("vault_edges", "space_id = $1 AND deleted_at <> $2", [projectSpaceId, backdated])).toBe(0);
  });
});
