import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The `contains` dual-write of §11.5: topic membership is written to `vault_edges` beside
 * `note_claims` for one release, with a parity control that REPORTS a divergence. What is
 * asserted here is the property that makes the later read switch safe — the two tables say
 * the same thing after every move — plus the one thing no schema can say, that a `contains`
 * edge runs topic -> claim and not the reverse.
 */
import { db, pool } from "@/lib/db";
import { attachToTopic, createClaim, forgetClaim, updateClaim, type Actor } from "../claims";
import { containsParity, linkNodes, unlinkEdge } from "../edges";
import { resolveTopic } from "../topics";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const P = "edgestest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`;
/** A second space, for the one edge the composite FKs make UNREPRESENTABLE rather than
 *  merely refused. */
const SPACE_B = `${P}space-b`;
const ACTOR: Actor = { kind: "user", id: OWNER };
const FK_VIOLATION = "23503";
const OWNER_AUTHORED = testServerClass("owner_authored");

const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

const claim = (spaceId: string, statement: string, topicNoteId?: string) =>
  createClaim({ spaceId, statement, origin: { kind: "test" }, sourceClass: OWNER_AUTHORED, topicNoteId }, ACTOR);

const liveEdges = async (spaceId: string) =>
  (
    await q(
      `SELECT relation, from_node_id, to_node_id FROM vault_edges
        WHERE space_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [spaceId],
    )
  ).rows as { relation: string; from_node_id: string; to_node_id: string }[];

const edgeRows = async (spaceId: string) =>
  (await q(`SELECT count(*)::int AS n FROM vault_edges WHERE space_id = $1`, [spaceId])).rows[0].n as number;

run("vault: contains edges beside note_claims", () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'edges test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
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
  });

  it("legal pairs only - a note may contain a claim, a claim may not contain a note", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30", t.id);
    expect(await liveEdges(SPACE_A)).toEqual([
      { relation: "contains", from_node_id: t.id, to_node_id: c.id },
    ]);
    // The reverse pair is the thing no CHECK can see: both endpoints are legal rows, both
    // FKs are satisfied, and only a read of the two KINDS refuses it.
    await expect(
      linkNodes({ spaceId: SPACE_A, from: c.id, to: t.id, relation: "contains", createdBy: ACTOR }, db),
    ).rejects.toThrow(/contains does not run claim -> note/);
  });

  it("refuses an endpoint that is not in the space at all", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const stranger = await claim(SPACE_B, "a fact filed elsewhere");
    await expect(
      linkNodes({ spaceId: SPACE_A, from: t.id, to: stranger.id, relation: "contains", createdBy: ACTOR }, db),
    ).rejects.toThrow(/endpoint not found/);
    expect(await edgeRows(SPACE_A)).toBe(0);
  });

  it("is idempotent on the live partial unique index", async () => {
    const t = await resolveTopic(SPACE_A, "Travel", db);
    const c = await claim(SPACE_A, "flights are booked through the office");
    const a = await linkNodes({ spaceId: SPACE_A, from: t.id, to: c.id, relation: "contains", createdBy: ACTOR }, db);
    expect(a.created).toBe(true);
    const b = await linkNodes({ spaceId: SPACE_A, from: t.id, to: c.id, relation: "contains", createdBy: ACTOR }, db);
    expect(b).toEqual({ id: a.id, created: false });
    // ONE row, not two: `onConflictDoNothing` has to be reached by the index, not by a
    // read-then-write that a concurrent writer could interleave with.
    expect(await edgeRows(SPACE_A)).toBe(1);
  });

  it("re-linking after a delete does NOT fork into two live edges", async () => {
    const t = await resolveTopic(SPACE_A, "Travel", db);
    const c = await claim(SPACE_A, "flights are booked through the office");
    const a = await linkNodes({ spaceId: SPACE_A, from: t.id, to: c.id, relation: "contains", createdBy: ACTOR }, db);
    expect(await unlinkEdge(a.id, SPACE_A, db)).toBe(true);
    // Re-driving the inverse cuts nothing: the guard is `deleted_at IS NULL`, so a second
    // pass does not move the tombstone.
    expect(await unlinkEdge(a.id, SPACE_A, db)).toBe(false);
    await linkNodes({ spaceId: SPACE_A, from: t.id, to: c.id, relation: "contains", createdBy: ACTOR }, db);
    expect(await liveEdges(SPACE_A)).toHaveLength(1);
    // And the tombstone is still there to explain the gap - the partial index is what
    // allows both rows to coexist.
    expect(await edgeRows(SPACE_A)).toBe(2);
  });

  it("a cross-space edge is unrepresentable, not merely refused", async () => {
    const t = await resolveTopic(SPACE_A, "Travel", db);
    const c = await claim(SPACE_B, "a fact filed elsewhere");
    await expect(
      q(
        `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
         VALUES ($1,$2,$3,$4,'contains','{}'::jsonb)`,
        [`${P}e`, SPACE_A, t.id, c.id],
      ),
    ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "vault_edges_to_node_fk" });
  });

  it("attachToTopic writes the edge beside the membership row", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30");
    await attachToTopic(c.id, t.id);
    // Idempotent on BOTH halves, exactly as `uniq_note_claims` already made the first.
    await attachToTopic(c.id, t.id);
    expect(await liveEdges(SPACE_A)).toEqual([{ relation: "contains", from_node_id: t.id, to_node_id: c.id }]);
    expect(await containsParity(SPACE_A, db)).toMatchObject({ ok: true });
  });

  it("a supersede moves the contains edge with the claim, exactly as note_claims moves", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30", t.id);
    const up = await updateClaim({
      claimId: c.id,
      expectedRevision: 1,
      patch: { statement: "the invoice terms are net 45" },
      sourceClass: OWNER_AUTHORED,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    // MOVED, not copied: the predecessor holds no live edge, which is the same terminal
    // state its `note_claims` row reaches in one UPDATE.
    expect(await liveEdges(SPACE_A)).toEqual([{ relation: "contains", from_node_id: t.id, to_node_id: up.id }]);
    expect(await containsParity(SPACE_A, db)).toMatchObject({ ok: true });
  });

  it("a supersede of an UNATTACHED claim takes the fallback topic on both halves", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30");
    const up = await updateClaim({
      claimId: c.id,
      expectedRevision: 1,
      patch: { statement: "the invoice terms are net 45", topicNoteId: t.id },
      sourceClass: OWNER_AUTHORED,
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(await liveEdges(SPACE_A)).toEqual([{ relation: "contains", from_node_id: t.id, to_node_id: up.id }]);
  });

  it("a forgotten claim leaves parity clean, though its note_claims row stays", async () => {
    // THE control for the parity check's live-node scope. `forgetClaim` deliberately keeps
    // the membership row ("forgetting a fact does not mean rewriting where it came from")
    // while `deleteNode` soft-deletes the edge — so an unscoped comparison would call every
    // forgotten fact a divergence, and the check would fire on ordinary use.
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30", t.id);
    expect(await forgetClaim({ claimId: c.id, expectedRevision: 1, allowedSpaceIds: [SPACE_A], actor: ACTOR })).toEqual({ ok: true });
    expect((await q(`SELECT count(*)::int AS n FROM note_claims WHERE claim_id = $1`, [c.id])).rows[0].n).toBe(1);
    expect(await liveEdges(SPACE_A)).toHaveLength(0);
    expect(await containsParity(SPACE_A, db)).toMatchObject({ ok: true });
  });

  it("containsParity reports a divergence rather than repairing one", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30", t.id);
    await q(`UPDATE vault_edges SET deleted_at = now() WHERE space_id = $1`, [SPACE_A]);
    const p = await containsParity(SPACE_A, db);
    expect(p.ok).toBe(false);
    expect(p.onlyInNoteClaims).toEqual([`${t.id}:${c.id}`]);
    expect(p.onlyInEdges).toEqual([]);
    // REPORTS, it does not repair: reading it twice returns the same divergence, and the
    // edge it named is still deleted.
    expect(await containsParity(SPACE_A, db)).toEqual(p);
    expect(await liveEdges(SPACE_A)).toHaveLength(0);
  });

  it("names the other side too, when an edge has no membership row", async () => {
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30");
    await linkNodes({ spaceId: SPACE_A, from: t.id, to: c.id, relation: "contains", createdBy: ACTOR }, db);
    await q(`DELETE FROM note_claims WHERE claim_id = $1`, [c.id]);
    const p = await containsParity(SPACE_A, db);
    expect(p).toMatchObject({ ok: false, onlyInNoteClaims: [], onlyInEdges: [`${t.id}:${c.id}`] });
  });

  it("the dev-only gate takes the write down with it", async () => {
    // Step 5 armed: outside production the parity control runs at the end of every
    // `contains` move and THROWS, inside the writer's own transaction. Without it a
    // dual-write a later edit forgets to keep in step survives all the way to the read
    // switch, which is the one failure this whole release exists to prevent.
    const t = await resolveTopic(SPACE_A, "Suppliers", db);
    const other = await resolveTopic(SPACE_A, "Travel", db);
    const c = await claim(SPACE_A, "the invoice terms are net 30", t.id);
    // A divergence introduced behind the writers' backs, exactly as a missed dual-write
    // would leave one.
    await q(`UPDATE vault_edges SET deleted_at = now() WHERE space_id = $1`, [SPACE_A]);
    await expect(attachToTopic(c.id, other.id)).rejects.toThrow(/contains parity diverged/);
    // And it took the write with it: the attach is not half-applied.
    expect((await q(`SELECT count(*)::int AS n FROM note_claims WHERE note_id = $1`, [other.id])).rows[0].n).toBe(0);
  });
});
