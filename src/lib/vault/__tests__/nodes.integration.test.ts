import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * "Every subtype row is created in one transaction with its node row." Asserted at the
 * three writers rather than inferred from the foreign key, because the FK only tells you
 * that SOMETHING inserted a node — not that the writer did it inside the same transaction,
 * which is what makes a rolled-back claim leave no orphan node behind.
 */
import { pool } from "@/lib/db";
import { createClaim, updateClaim, type Actor } from "../claims";
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
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const nodeOf = async (id: string) =>
  (await q(`SELECT kind, space_id, deleted_at FROM vault_nodes WHERE id = $1`, [id])).rows[0] ?? null;

const nodeCount = async (spaceId: string) =>
  (await q(`SELECT count(*)::int AS n FROM vault_nodes WHERE space_id = $1`, [spaceId])).rows[0].n as number;

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
    // a wrong address for a claim in SPACE_A, and minting it through the service would
    // put a node of its own in SPACE_B for the counting below to step around.
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
    await expect(
      createClaim(
        { spaceId: SPACE_A, statement: "filed under a stranger's topic", origin: { kind: "test" }, topicNoteId: NOTE_B },
        ACTOR,
      ),
    ).rejects.toThrow(/does not belong/);
    expect(await nodeCount(SPACE_A)).toBe(before);
    // And nothing landed in the other space either: the node carries SPACE_A, so a
    // surviving row would be counted above — this pins the second space at zero so the
    // assertion above cannot pass by the node having gone somewhere else.
    expect(await nodeCount(SPACE_B)).toBe(0);
  });
});
