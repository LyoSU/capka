import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_note_write` and `memory_link`, §4.6 / §4.8 / §7.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The subject is the PAIR of writes that has to be one move: an edge and the block that
 * mentions it. An edge without its block renders a link the note body does not mention; a
 * block without its edge is §7's unresolved-text case, which no tool may mint. So most cases
 * here assert both halves, and the negative cases assert that NEITHER half landed.
 */
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import { createClaim, type SourceClass } from "../claims";
import { makeHandleMap, type HandleMap } from "../handles";
import { UNRESOLVED_LINK, edgeIdsIn, edgeToken, renderBody } from "../links";
import { createNote, reviseNote, noteHead } from "../notes";
import { memoryLink, noteWrite, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "nwtest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

const USER_TURN = "The quarterly reporting deadline is the fifteenth of every month, please write that down.";

let handles: HandleMap;

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

const nodeIdOf = (handle: string) => handles.resolve(handle)!.nodeId;

const bodyOf = async (handle: string) =>
  (
    await q(
      `SELECT v.body_markdown AS b FROM vault_note_versions v
         JOIN vault_notes n ON n.id = v.note_id AND n.current_revision = v.revision
        WHERE v.note_id = $1`,
      [nodeIdOf(handle)],
    )
  ).rows[0].b as string;

/** Plain notes only. A write also RESOLVES a topic, and a topic is a `vault_notes` row of
 *  kind `memory_topic` — counting both would make "did this write land" depend on whether the
 *  space already had a General topic. */
const noteCount = async (spaceId: string) =>
  Number(
    (await q(`SELECT count(*) AS c FROM vault_notes WHERE space_id = $1 AND kind = 'note'`, [spaceId])).rows[0].c,
  );

const versionCount = async (handle: string) =>
  Number(
    (await q(`SELECT count(*) AS c FROM vault_note_versions WHERE note_id = $1`, [nodeIdOf(handle)])).rows[0].c,
  );

const edgeCount = async (spaceId: string, relation: string) =>
  Number(
    (
      await q(`SELECT count(*) AS c FROM vault_edges WHERE space_id = $1 AND relation = $2 AND deleted_at IS NULL`, [
        spaceId,
        relation,
      ])
    ).rows[0].c,
  );

const edgeRow = async (edgeId: string) => (await q(`SELECT * FROM vault_edges WHERE id = $1`, [edgeId])).rows[0];

/** A live claim head at a stated class, addressed by a freshly minted handle. */
const seedClaim = async (spaceId: string, statement: string, sourceClass: SourceClass) => {
  const claim = await createClaim(
    { spaceId, statement, origin: { kind: "seed" }, sourceClass: testServerClass(sourceClass) },
    { kind: "user", id: `${P}u` },
  );
  return { id: claim.id, handle: handles.mint({ kind: "m", spaceId, nodeId: claim.id }) };
};

/** A live note at a stated class — the LINK TARGET of most cases here, and the thing that
 *  gets renamed in the rename case. */
const seedNote = async (spaceId: string, title: string, sourceClass: SourceClass) => {
  const note = await createNote(
    { spaceId, title, bodyMarkdown: "seeded", sourceClass: testServerClass(sourceClass), provenance: { kind: "seed" } },
    db,
  );
  return { id: note.id, handle: handles.mint({ kind: "n", spaceId, nodeId: note.id }) };
};

run("memory_note_write", () => {
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

  it("a node_link block becomes an edge token and a references edge, in one transaction", async () => {
    const target = await seedNote(PS, "Reporting", "agent_inferred");
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [
        { kind: "markdown", text: "The deadline is the fifteenth." },
        { kind: "node_link", targetHandle: target.handle },
      ],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "created", revision: 1, linksCreated: 1, sourceClass: "agent_inferred" });
    if (r.status !== "created") throw new Error("narrowing");

    // The BLOCK: one canonical token, and the id inside it is the edge's.
    const body = await bodyOf(r.handle);
    const ids = edgeIdsIn(body);
    expect(ids.length).toBe(1);
    // The EDGE: live, `references`, from this note to the target — one row, this transaction.
    const edge = await edgeRow(ids[0]);
    expect(edge.from_node_id).toBe(nodeIdOf(r.handle));
    expect(edge.to_node_id).toBe(target.id);
    expect(edge.relation).toBe("references");
    expect(edge.deleted_at).toBeNull();
    // And the note is filed, so it is reachable from a topic rather than orphaned.
    expect(await edgeCount(PS, "contains")).toBe(1);
  });

  it("renaming the target changes every DISPLAY and touches no note body and no edge row", async () => {
    const target = await seedNote(PS, "Reporting", "agent_inferred");
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "node_link", targetHandle: target.handle }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "created") throw new Error("narrowing");

    const before = await bodyOf(r.handle);
    const edgeBefore = await edgeRow(edgeIdsIn(before)[0]);
    expect(await renderBody(before, PS)).toContain("Reporting");

    // The rename: a new revision of the TARGET with a different title, which is what a
    // rename control will be (§8: rename is never the agent's).
    await reviseNote(
      {
        noteId: target.id,
        spaceId: PS,
        expectedRevision: 1,
        title: "New Name",
        bodyMarkdown: "seeded",
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "rename" },
      },
      db,
    );

    expect(await bodyOf(r.handle)).toBe(before); // stored body: byte-identical
    expect(await renderBody(before, PS)).toContain("New Name");
    const edgeAfter = await edgeRow(edgeIdsIn(before)[0]);
    expect(edgeAfter).toEqual(edgeBefore);
  });

  it("the model cannot type a persistent [[Title]] link", async () => {
    await seedNote(PS, "Reporting", "agent_inferred");
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "see [[Reporting]]" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "created") throw new Error("narrowing");
    expect(await bodyOf(r.handle)).toContain("[[Reporting]]"); // stored as literal TEXT
    expect(await edgeCount(PS, "references")).toBe(0); // and it is not an edge
    expect(r.linksCreated).toBe(0);
    // Nor does the display path invent one: the token pattern does not match a bare title,
    // so the text survives rendering unchanged.
    expect(await renderBody(await bodyOf(r.handle), PS)).toContain("[[Reporting]]");
  });

  it("an unresolved target_handle rejects the whole write and returns the current handles", async () => {
    const target = await seedNote(PS, "Reporting", "agent_inferred");
    const before = await noteCount(PS);
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [
        { kind: "node_link", targetHandle: target.handle },
        { kind: "node_link", targetHandle: "n99" },
      ],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_handle");
    expect(r.said).toContain("n99");
    // The RESOLVABLE one is not named as unusable — the model is told which address to fix.
    expect(r.said).not.toContain(target.handle);
    // Nothing at all: not the note, not the edge, not a half-written body.
    expect(await noteCount(PS)).toBe(before);
    expect(await edgeCount(PS, "references")).toBe(0);
  });

  it("a link target in ANOTHER space is refused, and never written across the boundary", async () => {
    // The space fence, which is a rejection here and unrepresentable at the composite FK.
    // Both are the boundary; only one of them is an answer the model can act on.
    const foreign = await seedNote(US, "Personal reporting", "agent_inferred");
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "node_link", targetHandle: foreign.handle }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_handle");
    expect(await edgeCount(PS, "references")).toBe(0);
    expect(await edgeCount(US, "references")).toBe(0);
  });

  it("an untrusted_derived note says, in its own return, that it will not be asserted on its own", async () => {
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "What the vendor PDF says",
      content: [{ kind: "markdown", text: "Payment is due in 14 days." }],
      grounding: { kind: "agent_inference" },
      ctx: tainted(),
    });
    expect(r).toMatchObject({ status: "created", sourceClass: "untrusted_derived", promptAccess: "knowledge_search" });
    if (r.status !== "created") throw new Error("narrowing");
    expect(r.said).toContain("will not be asserted");
  });

  it("step 3 — an untrusted note is REFUSED into a user space, never downgraded or re-scoped", async () => {
    const r = await noteWrite({
      op: { kind: "create", scope: "user" },
      title: "What the vendor PDF says",
      content: [{ kind: "markdown", text: "Payment is due in 14 days." }],
      grounding: { kind: "agent_inference" },
      ctx: tainted(),
    });
    expect(r.status).toBe("refused_scope");
    expect(await noteCount(US)).toBe(0);
    expect(await noteCount(PS)).toBe(0);
  });

  it("an update is a CAS: it replaces the head version and keeps the previous one as history", async () => {
    const first = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "one" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (first.status !== "created") throw new Error("narrowing");
    const second = await noteWrite({
      op: { kind: "update", noteHandle: first.handle, expectedRevision: 1 },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "two" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(second).toMatchObject({ status: "updated", revision: 2, handle: first.handle });
    expect(await bodyOf(first.handle)).toBe("two");
    expect(await versionCount(first.handle)).toBe(2);
  });

  it("an update that drops a link closes its edge, and one that keeps a link keeps the token", async () => {
    const kept = await seedNote(PS, "Reporting", "agent_inferred");
    const dropped = await seedNote(PS, "Invoicing", "agent_inferred");
    const first = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [
        { kind: "node_link", targetHandle: kept.handle },
        { kind: "node_link", targetHandle: dropped.handle },
      ],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (first.status !== "created") throw new Error("narrowing");
    expect(first.linksCreated).toBe(2);
    const [keptToken, droppedToken] = edgeIdsIn(await bodyOf(first.handle));

    const second = await noteWrite({
      op: { kind: "update", noteHandle: first.handle, expectedRevision: 1 },
      title: "Deadlines",
      content: [{ kind: "node_link", targetHandle: kept.handle }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (second.status !== "updated") throw new Error(`expected updated, got ${second.status}`);
    // The surviving link keeps its EDGE and therefore its token, byte for byte: a revision
    // that did not touch a link must not rewrite it.
    expect(edgeIdsIn(await bodyOf(first.handle))).toEqual([keptToken]);
    expect(second.linksCreated).toBe(0);
    // The dropped one's edge is closed — an edge that outlived its block would render a link
    // the note body does not mention.
    expect(await edgeCount(PS, "references")).toBe(1);
    const closed = await q(
      `SELECT deleted_at FROM vault_edges WHERE space_id = $1 AND to_node_id = $2 AND relation = 'references'`,
      [PS, dropped.id],
    );
    expect(closed.rows[0].deleted_at).not.toBeNull();
    // And the closed edge's token no longer resolves to a title on the display path — which
    // is what makes closing the edge sufficient: no body has to be rewritten to hide it.
    expect(await renderBody(edgeToken(droppedToken), PS)).toBe(UNRESOLVED_LINK);
  });

  it("a lost CAS on an update writes nothing — no version, no edge — and reports the revision", async () => {
    const first = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "one" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (first.status !== "created") throw new Error("narrowing");
    const target = await seedNote(PS, "Reporting", "agent_inferred");

    const r = await noteWrite({
      op: { kind: "update", noteHandle: first.handle, expectedRevision: 7 },
      title: "Deadlines",
      content: [{ kind: "node_link", targetHandle: target.handle }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "revision_mismatch", revision: 1 });
    expect(await versionCount(first.handle)).toBe(1);
    expect(await edgeCount(PS, "references")).toBe(0);
  });

  it("step 5 — a weaker class cannot rewrite a stronger note, and nothing is written", async () => {
    // A note has no `conflicts_with`, so §10.1 bound 4 has no conflict row to degrade into:
    // the only implementation of "cannot supersede a trusted one" here is a refusal.
    const strong = await seedNote(PS, "The user's own procedure", "user_direct");
    const r = await noteWrite({
      op: { kind: "update", noteHandle: strong.handle, expectedRevision: 1 },
      title: "Rewritten",
      content: [{ kind: "markdown", text: "changed by the agent" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("refused_weaker_class");
    expect(await versionCount(strong.handle)).toBe(1);
    const head = await noteHead(strong.id, [PS]);
    expect(head!.title).toBe("The user's own procedure");
  });

  it("step 5 — an equal class in a TAINTED turn cannot rewrite a note either (N2)", async () => {
    // The quote earns `user_direct` even in a tainted turn — `classify` deliberately does not
    // tax a sentence the person typed for a document's presence in the same turn. So the
    // classes are EQUAL here and only the second condition can refuse the write, which is
    // the arm a class check alone leaves wide open.
    const own = await seedNote(PS, "Quarterly reporting deadline", "user_direct");
    const r = await noteWrite({
      op: { kind: "update", noteHandle: own.handle, expectedRevision: 1 },
      title: "Quarterly reporting deadline",
      content: [{ kind: "markdown", text: "The quarterly reporting deadline is the fifteenth of every month." }],
      grounding: {
        kind: "current_user_quote",
        quote: "The quarterly reporting deadline is the fifteenth of every month",
      },
      ctx: tainted(),
    });
    expect(r.status).toBe("refused_untrusted_turn");
    expect(await versionCount(own.handle)).toBe(1);

    // The control: the SAME call in a clean turn goes through, so the refusal above is the
    // taint's answer and not a class comparison passing sentence on it.
    const clean2 = await noteWrite({
      op: { kind: "update", noteHandle: own.handle, expectedRevision: 1 },
      title: "Quarterly reporting deadline",
      content: [{ kind: "markdown", text: "The quarterly reporting deadline is the fifteenth of every month." }],
      grounding: {
        kind: "current_user_quote",
        quote: "The quarterly reporting deadline is the fifteenth of every month",
      },
      ctx: clean(),
    });
    expect(clean2).toMatchObject({ status: "updated", revision: 2, sourceClass: "user_direct" });
  });

  it("step 9 — a retired space gains nothing, and says so instead of throwing", async () => {
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [PS]);
    const r = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "one" }],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("retired");
    expect(await noteCount(PS)).toBe(0);
  });

  it("a quote the statement is made of earns user_direct and files into personal memory", async () => {
    const r = await noteWrite({
      op: { kind: "create", scope: "user" },
      title: "Quarterly reporting deadline",
      content: [{ kind: "markdown", text: "The quarterly reporting deadline is the fifteenth of every month." }],
      grounding: {
        kind: "current_user_quote",
        quote: "The quarterly reporting deadline is the fifteenth of every month",
      },
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "created", sourceClass: "user_direct", promptAccess: "manifest" });
    expect(await noteCount(US)).toBe(1);
  });
});

run("memory_link", () => {
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

  it("adds the edge AND the block through a new revision, in one transaction", async () => {
    const from = await seedNote(PS, "Deadlines", "agent_inferred");
    const to = await seedClaim(PS, "Reporting is due on the fifteenth", "agent_inferred");
    const r = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: to.handle,
      expectedNoteRevision: 1,
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "linked", revision: 2 });
    if (r.status !== "linked") throw new Error("narrowing");

    const body = await bodyOf(from.handle);
    const ids = edgeIdsIn(body);
    expect(ids.length).toBe(1);
    // The block was APPENDED: the previous body survives byte for byte.
    expect(body.startsWith("seeded")).toBe(true);
    const edge = await edgeRow(ids[0]);
    expect(edge.from_node_id).toBe(from.id);
    expect(edge.to_node_id).toBe(to.id);
    expect(edge.deleted_at).toBeNull();
    // The handle it hands back addresses the EDGE, and it is not the edge's id.
    expect(r.edgeHandle).toMatch(/^g[1-9][0-9]{0,3}$/);
    expect(JSON.stringify(r)).not.toContain(ids[0]);
  });

  it("a lost CAS writes nothing and reports the current revision", async () => {
    const from = await seedNote(PS, "Deadlines", "agent_inferred");
    const to = await seedNote(PS, "Reporting", "agent_inferred");
    const r = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: to.handle,
      expectedNoteRevision: 4,
      ctx: clean(),
    });
    expect(r).toMatchObject({ status: "revision_mismatch", revision: 1 });
    // NEITHER half: the edge is created inside the revision's own CAS, so a lost race leaves
    // no edge for a later body to fail to mention.
    expect(await edgeCount(PS, "references")).toBe(0);
    expect(await versionCount(from.handle)).toBe(1);
    expect(await bodyOf(from.handle)).toBe("seeded");
  });

  it("a second call for the same pair writes nothing rather than a duplicate block", async () => {
    const from = await seedNote(PS, "Deadlines", "agent_inferred");
    const to = await seedNote(PS, "Reporting", "agent_inferred");
    const first = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: to.handle,
      expectedNoteRevision: 1,
      ctx: clean(),
    });
    if (first.status !== "linked") throw new Error("narrowing");
    const again = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: to.handle,
      expectedNoteRevision: 2,
      ctx: clean(),
    });
    expect(again).toMatchObject({ status: "already_linked", edgeHandle: first.edgeHandle, revision: 2 });
    // `uniq_live_vault_edge` makes the EDGE idempotent; the body is not, which is why the
    // check is in the tool and not left to the insert.
    expect(edgeIdsIn(await bodyOf(from.handle)).length).toBe(1);
    expect(await versionCount(from.handle)).toBe(2);
  });

  it("cannot rewrite a note carrying more authority, and cannot rewrite any note in a tainted turn", async () => {
    const strong = await seedNote(PS, "The user's own procedure", "user_direct");
    const to = await seedNote(PS, "Reporting", "agent_inferred");
    expect(
      (await memoryLink({ fromNoteHandle: strong.handle, targetHandle: to.handle, expectedNoteRevision: 1, ctx: clean() }))
        .status,
    ).toBe("refused_weaker_class");

    // `agent_inference` floors at `untrusted_derived` in a tainted turn, so the class arm
    // only stays silent on a note that is ALREADY at that class — which is where the taint
    // condition is the one thing standing.
    const own = await seedNote(PS, "What the vendor PDF says", "untrusted_derived");
    expect(
      (await memoryLink({ fromNoteHandle: own.handle, targetHandle: to.handle, expectedNoteRevision: 1, ctx: tainted() }))
        .status,
    ).toBe("refused_untrusted_turn");
    // The control: the same note, the same call, a CLEAN turn — allowed, so the refusal
    // above is the taint's and not the class comparison's.
    expect(
      (await memoryLink({ fromNoteHandle: own.handle, targetHandle: to.handle, expectedNoteRevision: 1, ctx: clean() }))
        .status,
    ).toBe("linked");
  });

  it("refuses a target in another space, a self-link, and a claim as the source", async () => {
    const from = await seedNote(PS, "Deadlines", "agent_inferred");
    const foreign = await seedNote(US, "Personal", "agent_inferred");
    const claim = await seedClaim(PS, "Reporting is due on the fifteenth", "agent_inferred");

    expect(
      (await memoryLink({ fromNoteHandle: from.handle, targetHandle: foreign.handle, expectedNoteRevision: 1, ctx: clean() }))
        .status,
    ).toBe("bad_handle");
    expect(
      (await memoryLink({ fromNoteHandle: from.handle, targetHandle: from.handle, expectedNoteRevision: 1, ctx: clean() }))
        .status,
    ).toBe("bad_handle");
    // `references` runs note -> anything, never claim -> anything (§2.4), and the letter is
    // the whole of what a handle says about its target.
    expect(
      (await memoryLink({ fromNoteHandle: claim.handle, targetHandle: from.handle, expectedNoteRevision: 1, ctx: clean() }))
        .status,
    ).toBe("bad_handle");
    expect(await edgeCount(PS, "references")).toBe(0);
    expect(await edgeCount(US, "references")).toBe(0);
  });

  it("a token whose edge was closed renders as text carrying no id", async () => {
    const from = await seedNote(PS, "Deadlines", "agent_inferred");
    const to = await seedNote(PS, "Reporting", "agent_inferred");
    const r = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: to.handle,
      expectedNoteRevision: 1,
      ctx: clean(),
    });
    if (r.status !== "linked") throw new Error("narrowing");
    const body = await bodyOf(from.handle);
    const [edgeId] = edgeIdsIn(body);
    await q(`UPDATE vault_edges SET deleted_at = now() WHERE id = $1`, [edgeId]);

    const rendered = await renderBody(body, PS);
    expect(rendered).toContain(UNRESOLVED_LINK);
    expect(rendered).not.toContain(edgeId);
    expect(rendered).not.toContain("Reporting");
  });
});

/** The suite leaves nothing behind, which is what makes the live counts in the report
 *  readable. An assertion rather than a comment: a fixture that leaks is invisible until
 *  somebody reads the wrong number. */
run("memory_note_write fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const { rows } = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(rows[0].c)).toBe(0);
  });
});
