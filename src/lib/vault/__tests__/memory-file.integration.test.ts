import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_file`, §4.7 — one `contains` edge, from a topic to a fact or a note.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The interesting cases are the refusals, because each of them is a sentence that has to
 * name the right tool or the right argument: a model told only "no" retries with the same
 * handle. The cross-space case is asserted TWICE — at the tool and at the foreign key —
 * because the tool's check is a nicer message and not the boundary.
 */
import { asSchema } from "ai";
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import { createClaim, type SourceClass } from "../claims";
import { makeHandleMap, type HandleMap } from "../handles";
import { createNote } from "../notes";
import { makeVaultMemoryTools } from "../tools";
import { resolveTopic } from "../topics";
import { memoryFile, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "mftest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

let handles: HandleMap;

const ctx = (): WriteCtx => ({
  userSpaceId: US,
  projectSpaceId: PS,
  handles,
  taint: makeTurnTaint({ messageId: `${P}msg`, seeded: false, write: async () => {} }),
  budget: makeVaultBudget(),
  taskId: `${P}task`,
  messageId: `${P}msg`,
  userTurnText: "file that under suppliers, please",
  actor: { kind: "agent" },
});

const nodeIdOf = (h: string) => handles.resolve(h)!.nodeId;

const seedClaim = async (spaceId: string, statement: string, cls: SourceClass = "agent_inferred") => {
  const claim = await createClaim(
    { spaceId, statement, origin: { kind: "seed" }, sourceClass: testServerClass(cls) },
    { kind: "user", id: `${P}u` },
  );
  return { id: claim.id, handle: handles.mint({ kind: "m", spaceId, nodeId: claim.id }) };
};

const seedNote = async (spaceId: string, title: string) => {
  const note = await createNote(
    { spaceId, title, bodyMarkdown: "seeded", sourceClass: testServerClass("agent_inferred"), provenance: {} },
    db,
  );
  return { id: note.id, handle: handles.mint({ kind: "n", spaceId, nodeId: note.id }) };
};

const seedTopic = async (spaceId: string, title: string) => {
  const t = await resolveTopic(spaceId, title, db);
  return { id: t.id as string, handle: handles.mint({ kind: "n", spaceId, nodeId: t.id }) };
};

const containsEdges = async (spaceId: string) =>
  (
    await q(
      `SELECT from_node_id, to_node_id, created_by FROM vault_edges
        WHERE space_id = $1 AND relation = 'contains' AND deleted_at IS NULL`,
      [spaceId],
    )
  ).rows as { from_node_id: string; to_node_id: string; created_by: { kind: string } }[];

const memberships = async (claimId: string) =>
  (await q(`SELECT note_id FROM note_claims WHERE claim_id = $1`, [claimId])).rows.map((r) => r.note_id as string);

run("memory_file", () => {
  beforeEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [US, `${P}u`]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      PS,
      `${P}proj`,
      `${P}u`,
    ]);
    handles = makeHandleMap();
  });

  afterEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
  });

  it("files an m handle under a topic and returns the edge handle", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    const r = await memoryFile({ itemHandle: claim.handle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() });
    expect(r.status).toBe("filed");
    if (r.status !== "filed") throw new Error("narrowing");
    expect(r.edgeHandle).toMatch(/^g[1-9][0-9]{0,3}$/);
    expect(r.said).toContain("Suppliers");
    // The edge AND the membership row: §11.5's dual-write goes through `attachToTopic`, so a
    // reader of either table sees the same topic.
    expect(await containsEdges(PS)).toEqual([
      expect.objectContaining({ from_node_id: topic.id, to_node_id: claim.id, created_by: { kind: "agent" } }),
    ]);
    expect(await memberships(claim.id)).toEqual([topic.id]);
    // The edge id is never shown; the handle is the whole address.
    expect(JSON.stringify(r)).not.toContain(topic.id);
  });

  it("files an n handle under a topic, with no membership row to mirror", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    const note = await seedNote(PS, "Vendor onboarding");
    const r = await memoryFile({ itemHandle: note.handle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() });
    expect(r.status).toBe("filed");
    expect(await containsEdges(PS)).toEqual([
      expect.objectContaining({ from_node_id: topic.id, to_node_id: note.id }),
    ]);
    // `note_claims` cannot represent a topic containing a NOTE, which is also why
    // `containsParity` scopes its edge side to claim targets: this edge is not a divergence.
    const { rows } = await q(`SELECT count(*) AS c FROM note_claims WHERE note_id = $1`, [topic.id]);
    expect(Number(rows[0].c)).toBe(0);
  });

  it("is idempotent: filing the same pair twice leaves one live edge", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    const args = { itemHandle: claim.handle, topicHandle: topic.handle, expectedItemRevision: 1 };
    const first = await memoryFile({ ...args, ctx: ctx() });
    const again = await memoryFile({ ...args, ctx: ctx() });
    expect(again.status).toBe("filed");
    if (first.status !== "filed" || again.status !== "filed") throw new Error("narrowing");
    // The SAME edge, so the same handle: `uniq_live_vault_edge` makes the write idempotent
    // and `handles.mint` folds one target onto one handle.
    expect(again.edgeHandle).toBe(first.edgeHandle);
    expect(await containsEdges(PS)).toHaveLength(1);
  });

  it("refuses an f handle with the sentence that names the right tool", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    // No writer mints an `f` handle before slice 3, so the arm is exercised by minting one:
    // what is under test is the tool's answer to a document, not the ingest that makes one.
    const fHandle = handles.mint({ kind: "f", spaceId: PS, nodeId: `${P}source` });
    const r = await memoryFile({ itemHandle: fHandle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() });
    expect(r.status).toBe("wrong_kind");
    expect(r.said).toMatch(/memory_link/);
    expect(await containsEdges(PS)).toEqual([]);
  });

  it("refuses an e or a g handle with a sentence that says what they are", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    for (const kind of ["e", "g"] as const) {
      const h = handles.mint({ kind, spaceId: PS, nodeId: `${P}${kind}` });
      const r = await memoryFile({ itemHandle: h, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() });
      expect(r.status, kind).toBe("wrong_kind");
      // NOT the document sentence: pointing at `memory_link` for a fragment would be an
      // instruction the model cannot follow either.
      expect(r.said, kind).not.toMatch(/memory_link/);
    }
    expect(await containsEdges(PS)).toEqual([]);
  });

  it("refuses a plain note as the TOPIC, and names the wrong argument", async () => {
    const notATopic = await seedNote(PS, "Vendor onboarding");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    const r = await memoryFile({
      itemHandle: claim.handle,
      topicHandle: notATopic.handle,
      expectedItemRevision: 1,
      ctx: ctx(),
    });
    expect(r.status).toBe("wrong_kind");
    expect(r.said).toMatch(/not a topic/);
    expect(await containsEdges(PS)).toEqual([]);
  });

  it("requires expected_item_revision — an optional CAS parameter is an optional CAS (M17)", async () => {
    const schema = asSchema((await tools()).memory_file.inputSchema as never);
    const accepts = async (v: unknown) => (await schema.validate!(v)).success;
    expect(await accepts({ item_handle: "m1", topic_handle: "n1" })).toBe(false);
    expect(await accepts({ item_handle: "m1", topic_handle: "n1", expected_item_revision: 1 })).toBe(true);
    // And it is CHECKED, not merely required: a stale revision writes nothing and says where
    // the item is now.
    const topic = await seedTopic(PS, "Suppliers");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    const r = await memoryFile({ itemHandle: claim.handle, topicHandle: topic.handle, expectedItemRevision: 3, ctx: ctx() });
    expect(r).toMatchObject({ status: "revision_mismatch", revision: 1 });
    expect(await containsEdges(PS)).toEqual([]);
  });

  it("cross-space filing is refused by the tool AND unrepresentable at the foreign key", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    const personal = await seedClaim(US, "I prefer EUR");
    const r = await memoryFile({ itemHandle: personal.handle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() });
    expect(r.status).toBe("wrong_scope");
    expect(await containsEdges(PS)).toEqual([]);
    expect(await containsEdges(US)).toEqual([]);

    // THE BOUNDARY, asserted separately: the tool's check is a better error message and
    // nothing more, so the row it declines to write is a row the database also refuses.
    await expect(
      q(
        `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
         VALUES ($1,$2,$3,$4,'contains','{"kind":"system"}')`,
        [`${P}edge`, PS, topic.id, personal.id],
      ),
    ).rejects.toThrow(/foreign key|vault_edges_to_node_fk/i);
  });

  it("a forgotten item is not found, and a retired space says so instead of throwing", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    await q(`UPDATE vault_claims SET superseded_at = now() WHERE id = $1`, [claim.id]);
    expect(
      (await memoryFile({ itemHandle: claim.handle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() })).status,
    ).toBe("not_found");

    const live = await seedClaim(PS, "The office moved to Lviv");
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [PS]);
    expect(
      (await memoryFile({ itemHandle: live.handle, topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() })).status,
    ).toBe("retired");
  });

  it("a fabricated handle resolves to nothing and writes nothing", async () => {
    const topic = await seedTopic(PS, "Suppliers");
    expect(
      (await memoryFile({ itemHandle: "m99", topicHandle: topic.handle, expectedItemRevision: 1, ctx: ctx() })).status,
    ).toBe("not_found");
    const claim = await seedClaim(PS, "Acme invoices are paid monthly");
    expect(
      (await memoryFile({ itemHandle: claim.handle, topicHandle: "n99", expectedItemRevision: 1, ctx: ctx() })).status,
    ).toBe("not_found");
    expect(await containsEdges(PS)).toEqual([]);
    void nodeIdOf(claim.handle);
  });
});

/** The factory, for the one assertion that is about the provider-facing SCHEMA rather than
 *  about the writer. It resolves real spaces, which is why it lives in the integration file
 *  rather than in `tools.test.ts` where `getOrCreateSpace` is a stub. */
const tools = async () =>
  makeVaultMemoryTools({
    userId: `${P}u`,
    projectId: `${P}proj`,
    projectOwnerUserId: `${P}u`,
    messageId: `${P}msg`,
    taskId: `${P}task`,
    userTurnText: "",
    handles: makeHandleMap(),
    budget: makeVaultBudget(),
    taint: makeTurnTaint({ messageId: `${P}msg`, seeded: false, write: async () => {} }),
  });

run("memory_file fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const { rows } = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(rows[0].c)).toBe(0);
  });
});
