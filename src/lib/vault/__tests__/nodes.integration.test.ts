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
const ACTOR: Actor = { kind: "user", id: OWNER };
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const nodeOf = async (id: string) =>
  (await q(`SELECT kind, space_id, deleted_at FROM vault_nodes WHERE id = $1`, [id])).rows[0] ?? null;

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

  it("leaves no orphan node when the claim write rolls back", async () => {
    // The retired-space fence throws AFTER nothing and BEFORE everything, so the honest
    // control is a space that refuses writes: the whole transaction rolls back and there
    // must be no node row for the id it would have used. Counting is the assertion —
    // the id is not observable from outside.
    const before = await q(`SELECT count(*)::int AS n FROM vault_nodes WHERE space_id = $1`, [SPACE_A]);
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [SPACE_A]);
    await expect(
      createClaim({ spaceId: SPACE_A, statement: "written into a retired space", origin: { kind: "test" } }, ACTOR),
    ).rejects.toThrow(/retired/);
    const after = await q(`SELECT count(*)::int AS n FROM vault_nodes WHERE space_id = $1`, [SPACE_A]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
