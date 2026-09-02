import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_note_write`'s in-place arms — `str_replace`, `insert`, `rename` (§4.6 as task 2c
 * extends it), against a live database.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The unit suite owns the arithmetic. What is under test here is that an edit is an
 * ORDINARY note write in every respect that matters downstream: it goes through
 * `reviseNote`'s CAS, it keeps the previous version, it announces itself as `note.revise`
 * so the chat notice can offer Undo, and §4.5's fence stands over it exactly as it stands
 * over a rewrite — a small edit is still a supersede of the head the manifest reads.
 */
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import type { SourceClass } from "../claims";
import { makeHandleMap, type HandleMap } from "../handles";
import { edgeIdsIn } from "../links";
import { createNote, noteHead, revertNote } from "../notes";
import { memoryOpen } from "../read-tools";
import { resolveTopic } from "../topics";
import { readTurnWrites } from "../turn-writes";
import { memoryLink, noteEdit, noteWrite, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "netest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const UID = `${P}u`;
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

const seedNote = async (spaceId: string, title: string, body: string, cls: SourceClass = "agent_inferred") => {
  const note = await createNote(
    { spaceId, title, bodyMarkdown: body, sourceClass: testServerClass(cls), provenance: {} },
    db,
  );
  return { id: note.id, handle: handles.mint({ kind: "n", spaceId, nodeId: note.id }) };
};

const storedBody = async (noteId: string) =>
  (
    await q(
      `SELECT v.body_markdown AS b FROM vault_note_versions v
         JOIN vault_notes n ON n.id = v.note_id AND n.current_revision = v.revision
        WHERE v.note_id = $1`,
      [noteId],
    )
  ).rows[0].b as string;

const versionCount = async (noteId: string) =>
  Number((await q(`SELECT count(*) AS c FROM vault_note_versions WHERE note_id = $1`, [noteId])).rows[0].c);

const liveEdgeIds = async (noteId: string) =>
  (
    await q(
      `SELECT id FROM vault_edges WHERE from_node_id = $1 AND relation = 'references' AND deleted_at IS NULL ORDER BY id`,
      [noteId],
    )
  ).rows.map((r) => r.id as string);

run("in-place note edits", () => {
  beforeEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM "user" WHERE id LIKE $1`, [`${P}%`]);
    await q(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1,$2,$3,false)`, [
      UID,
      "Edit fixture",
      `${P}u@example.test`,
    ]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [US, UID]);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      PS,
      `${P}proj`,
      UID,
    ]);
    handles = makeHandleMap();
  });

  afterEach(async () => {
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM "user" WHERE id LIKE $1`, [`${P}%`]);
  });

  it("str_replace writes revision 2, keeps revision 1, and shows the file around the change", async () => {
    const note = await seedNote(PS, "Deadlines", "The deadline is the fifteenth.\n\nAsk Olena.");
    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: note.handle,
        expectedRevision: 1,
        oldStr: "the fifteenth",
        newStr: "the twentieth",
      },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "edited") throw new Error(`expected edited, got ${r.status}: ${r.said}`);
    expect(r.revision).toBe(2);
    expect(r.linksRemoved).toBe(0);
    expect(await storedBody(note.id)).toBe("The deadline is the twentieth.\n\nAsk Olena.");
    // BOTH versions kept: history is append-only, which is what makes the notice's Undo a
    // new revision rather than a rollback.
    expect(await versionCount(note.id)).toBe(2);

    // THE SNIPPET, numbered exactly as memory_open numbers it, so the model can see the
    // edit landed where it meant without spending a second read.
    expect(r.said).toContain("The memory file has been edited.");
    expect(r.said).toContain("     1\tThe deadline is the twentieth.");
    expect(r.said).toContain("     3\tAsk Olena.");
  });

  it("insert adds lines after the one it names and leaves the rest alone", async () => {
    const note = await seedNote(PS, "Deadlines", "one\ntwo");
    const r = await noteEdit({
      op: { kind: "insert", noteHandle: note.handle, expectedRevision: 1, insertLine: 1, insertText: "middle" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "edited") throw new Error(`expected edited, got ${r.status}: ${r.said}`);
    expect(await storedBody(note.id)).toBe("one\nmiddle\ntwo");
    expect(r.said).toContain("     2\tmiddle");
  });

  it("rename changes the title and nothing else", async () => {
    const note = await seedNote(PS, "Deadlines", "The deadline is the fifteenth.");
    const r = await noteEdit({
      op: { kind: "rename", noteHandle: note.handle, expectedRevision: 1, title: "Reporting deadlines" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "renamed") throw new Error(`expected renamed, got ${r.status}: ${r.said}`);
    expect(r.revision).toBe(2);
    const head = await noteHead(note.id, [PS]);
    expect(head!.title).toBe("Reporting deadlines");
    expect(head!.bodyMarkdown).toBe("The deadline is the fifteenth.");
  });

  it("every arm records note.revise carrying WHICH edit it was", async () => {
    const note = await seedNote(PS, "Deadlines", "one\ntwo");
    await noteEdit({
      op: { kind: "str_replace", noteHandle: note.handle, expectedRevision: 1, oldStr: "one", newStr: "ONE" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    await noteEdit({
      op: { kind: "insert", noteHandle: note.handle, expectedRevision: 2, insertLine: 2, insertText: "three" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    await noteEdit({
      op: { kind: "rename", noteHandle: note.handle, expectedRevision: 3, title: "Renamed" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });

    const events = await q(
      `SELECT payload ->> 'revision' AS revision FROM audit_events
        WHERE action = 'note.revise' AND subject_id = $1 ORDER BY (payload ->> 'revision')::int`,
      [note.id],
    );
    // Revision 1 is `createNote`'s own event: `insertNoteVersion` writes one for every
    // version, which is what keeps a fourth note writer from arriving unannounced.
    expect(events.rows.map((r) => Number(r.revision))).toEqual([1, 2, 3, 4]);
    // The version's own provenance is what names the edit — the audit payload deliberately
    // carries no text and no wording of its own.
    const provs = await q(
      `SELECT provenance ->> 'edit' AS edit FROM vault_note_versions WHERE note_id = $1 ORDER BY revision`,
      [note.id],
    );
    expect(provs.rows.map((r) => r.edit)).toEqual([null, "str_replace", "insert", "rename"]);
  });

  it("the turn's notice names the file ONCE with the new revision, and Undo restores the old text", async () => {
    const note = await seedNote(US, "Deadlines", "The deadline is the fifteenth.");
    const edited = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: note.handle,
        expectedRevision: 1,
        oldStr: "fifteenth",
        newStr: "twentieth",
      },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (edited.status !== "edited") throw new Error(`expected edited, got ${edited.status}: ${edited.said}`);

    const writes = await readTurnWrites([`${P}msg`], UID);
    expect(writes[`${P}msg`]).toHaveLength(1);
    expect(writes[`${P}msg`][0]).toMatchObject({ id: note.id, kind: "note", revision: 2 });

    // The notice's Undo on a revision above 1 reverts THE EDIT, and does it the append-only
    // way: revision 3 carrying revision 1's words.
    const undone = await revertNote({ noteId: note.id, spaceId: US, toRevision: 1, actor: { kind: "user", id: UID } });
    expect(undone).toEqual({ ok: true, revision: 3 });
    expect(await storedBody(note.id)).toBe("The deadline is the fifteenth.");
  });

  it("an edit that drops one link closes exactly that edge and leaves the others open", async () => {
    const reporting = await seedNote(PS, "Reporting", "seeded");
    const payroll = await seedNote(PS, "Payroll", "seeded");
    const from = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [
        { kind: "markdown", text: "See these." },
        { kind: "node_link", targetHandle: reporting.handle },
        { kind: "node_link", targetHandle: payroll.handle },
      ],
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (from.status !== "created") throw new Error(`expected created, got ${from.status}`);
    const fromId = nodeIdOf(from.handle);
    expect(await liveEdgeIds(fromId)).toHaveLength(2);

    // The model edits what it SAW: the rendered title, not the stored token.
    const opened = await memoryOpen({ handle: from.handle, ctx: clean() });
    if (opened.status !== "opened" || opened.kind !== "note") throw new Error("narrowing");
    expect(opened.body).toContain("[[Reporting]]");

    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: from.handle,
        expectedRevision: from.revision,
        oldStr: "[[Reporting]]",
        newStr: "",
      },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "edited") throw new Error(`expected edited, got ${r.status}: ${r.said}`);
    expect(r.linksRemoved).toBe(1);

    const body = await storedBody(fromId);
    expect(edgeIdsIn(body)).toHaveLength(1);
    // EXACTLY that one edge: an edge that outlives its token renders a link the file does
    // not make, and closing the wrong one loses a link the file still makes.
    const live = await liveEdgeIds(fromId);
    expect(live).toEqual(edgeIdsIn(body));
  });

  it("a turn that read a document cannot edit an existing file, and writes nothing", async () => {
    // THE USER'S OWN WORDS, so the class fence is not what refuses this: `current_user_quote`
    // is deliberately not capped by taint, and the edit still lands `user_direct`. What stops
    // it is the second condition of step 5 — a turn that read a document may not supersede a
    // head, at any class — which is the one this case exists to pin.
    const note = await seedNote(PS, "Deadlines", "The deadline is the fifteenth.");
    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: note.handle,
        expectedRevision: 1,
        oldStr: "the fifteenth",
        newStr: "the fifteenth of every month",
      },
      grounding: { kind: "current_user_quote", quote: "the fifteenth of every month" },
      ctx: tainted(),
    });
    expect(r.status).toBe("refused_untrusted_turn");
    expect(await versionCount(note.id)).toBe(1);
    expect(await storedBody(note.id)).toBe("The deadline is the fifteenth.");
  });

  it("a weaker class cannot edit a stronger file — one file, one class per revision", async () => {
    // The user's own words are the head's class; an agent inference does not outrank them,
    // and there is no way to mark one edited sentence as weaker than the file it sits in.
    const note = await seedNote(PS, "Deadlines", "The deadline is the fifteenth.", "user_direct");
    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: note.handle,
        expectedRevision: 1,
        oldStr: "fifteenth",
        newStr: "twentieth",
      },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("refused_weaker_class");
    expect(await versionCount(note.id)).toBe(1);
  });

  it("an untrusted edit into the user space is refused by the fence, not filed elsewhere", async () => {
    const note = await seedNote(US, "Deadlines", "The deadline is the fifteenth.");
    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: note.handle,
        expectedRevision: 1,
        oldStr: "fifteenth",
        newStr: "twentieth",
      },
      grounding: { kind: "agent_inference" },
      ctx: tainted({ project: null }),
    });
    expect(r.status).toBe("refused_no_project");
    expect(await versionCount(note.id)).toBe(1);
  });

  it("refuses text that would push the file past what a whole write may store", async () => {
    const note = await seedNote(PS, "Deadlines", "lorem ipsum dolor sit amet ".repeat(1_481));
    const r = await noteEdit({
      op: { kind: "insert", noteHandle: note.handle, expectedRevision: 1, insertLine: 1, insertText: "y".repeat(500) },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("too_long");
    expect(await versionCount(note.id)).toBe(1);
  });

  it("a stale expected_revision is refused and says what the revision is now", async () => {
    const note = await seedNote(PS, "Deadlines", "one\ntwo");
    await noteEdit({
      op: { kind: "str_replace", noteHandle: note.handle, expectedRevision: 1, oldStr: "one", newStr: "ONE" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    const r = await noteEdit({
      op: { kind: "str_replace", noteHandle: note.handle, expectedRevision: 1, oldStr: "two", newStr: "TWO" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    if (r.status !== "revision_mismatch") throw new Error(`expected revision_mismatch, got ${r.status}`);
    expect(r.revision).toBe(2);
    expect(await versionCount(note.id)).toBe(2);
  });

  it("says which lines a duplicate sits on, and finds nothing when the text is not there", async () => {
    const note = await seedNote(PS, "Deadlines", "alpha\nbeta\nalpha");
    const dup = await noteEdit({
      op: { kind: "str_replace", noteHandle: note.handle, expectedRevision: 1, oldStr: "alpha", newStr: "gamma" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(dup.status).toBe("ambiguous_match");
    expect(dup.said).toContain("lines: 1, 3");

    const missing = await noteEdit({
      op: { kind: "str_replace", noteHandle: note.handle, expectedRevision: 1, oldStr: "delta", newStr: "x" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(missing.status).toBe("no_match");
    expect(missing.said).toContain("(revision 1)");
    expect(await versionCount(note.id)).toBe(1);
  });

  it("refuses an insert_line the file does not have, naming the range", async () => {
    const note = await seedNote(PS, "Deadlines", "one\ntwo");
    const r = await noteEdit({
      op: { kind: "insert", noteHandle: note.handle, expectedRevision: 1, insertLine: 9, insertText: "x" },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_line");
    expect(r.said).toContain("[0, 2]");
  });

  it("refuses a canonical link token typed into an edit", async () => {
    const target = await seedNote(PS, "Reporting", "seeded");
    const from = await seedNote(PS, "Deadlines", "See these.");
    const linked = await memoryLink({
      fromNoteHandle: from.handle,
      targetHandle: target.handle,
      expectedNoteRevision: 1,
      ctx: clean(),
    });
    if (linked.status !== "linked") throw new Error(`expected linked, got ${linked.status}`);
    const [edgeId] = await liveEdgeIds(from.id);

    const r = await noteEdit({
      op: {
        kind: "str_replace",
        noteHandle: from.handle,
        expectedRevision: 2,
        oldStr: "See these.",
        newStr: `See [[capka-edge:${edgeId}]].`,
      },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(r.status).toBe("bad_link");
    expect(r.said).toContain("node_link");
  });

  it("a topic container is a file and is edited like one", async () => {
    // §4.6's handle rule is `n` only, and a container IS an `n`. What still stands over it is
    // the class fence: `resolveTopic` writes a container at `owner_authored`, so an agent
    // inference cannot touch it and the user's own words — equal rank, which is what makes
    // `mayOutrank` an "equal or stronger" test — can.
    const topic = await resolveTopic(PS, "Suppliers", db);
    const handle = handles.mint({ kind: "n", spaceId: PS, nodeId: topic.id });

    const guessed = await noteEdit({
      op: { kind: "insert", noteHandle: handle, expectedRevision: 1, insertLine: 0, insertText: "Acme invoices." },
      grounding: { kind: "agent_inference" },
      ctx: clean(),
    });
    expect(guessed.status).toBe("refused_weaker_class");

    const r = await noteEdit({
      op: {
        kind: "insert",
        noteHandle: handle,
        expectedRevision: 1,
        insertLine: 0,
        insertText: "The deadline is the fifteenth of every month.",
      },
      grounding: { kind: "current_user_quote", quote: "the fifteenth of every month" },
      ctx: clean(),
    });
    if (r.status !== "edited") throw new Error(`expected edited, got ${r.status}: ${r.said}`);
    expect(await storedBody(topic.id)).toBe("The deadline is the fifteenth of every month.");
    expect(r.sourceClass).toBe("user_direct");
  });
});

run("in-place note edit fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const spaces = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    const users = await q(`SELECT count(*) AS c FROM "user" WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(spaces.rows[0].c)).toBe(0);
    expect(Number(users.rows[0].c)).toBe(0);
  });
});
