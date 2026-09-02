import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `memory_forget`, §4.9 — the same-task bound.
 *
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * THE SUBJECT IS WHERE THE BOUND LIVES, not that it exists. A legitimately obtained handle
 * for an older row must fail, and it must fail IN THE STATEMENT: reachability is not
 * authority, and this repo's history says a rule enforced at one entrance grows a second. So
 * the two central cases differ only in one column of the seeded row, and both assert what the
 * database did rather than what the tool returned.
 */
import { db, pool } from "@/lib/db";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import { createClaim, type SourceClass } from "../claims";
import { makeHandleMap, type HandleMap } from "../handles";
import { createNote } from "../notes";
import { memoryForget, noteWrite, type WriteCtx } from "../write-tools";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "mgtest-";
const US = `${P}space-user`;
const PS = `${P}space-project`;
const TASK = `${P}task`;
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

let handles: HandleMap;

const ctx = (over: { taskId?: string } = {}): WriteCtx => ({
  userSpaceId: US,
  projectSpaceId: PS,
  handles,
  taint: makeTurnTaint({ messageId: `${P}msg`, seeded: false, write: async () => {} }),
  budget: makeVaultBudget(),
  taskId: over.taskId ?? TASK,
  messageId: `${P}msg`,
  userTurnText: "",
  actor: { kind: "agent" },
});

/** A claim written BY A NAMED TASK — the one column the bound compares. */
const seedClaim = async (a: { spaceId?: string; createdTaskId?: string; cls?: SourceClass } = {}) => {
  const claim = await createClaim(
    {
      spaceId: a.spaceId ?? PS,
      statement: `fact ${Math.random()}`,
      origin: { kind: "seed" },
      sourceClass: testServerClass(a.cls ?? "agent_inferred"),
      createdTaskId: a.createdTaskId,
    },
    { kind: "agent" },
  );
  return { id: claim.id, handle: handles.mint({ kind: "m", spaceId: a.spaceId ?? PS, nodeId: claim.id }) };
};

const seedNote = async (a: { createdTaskId?: string } = {}) => {
  const note = await createNote(
    {
      spaceId: PS,
      title: `note ${Math.random()}`,
      bodyMarkdown: "body",
      sourceClass: testServerClass("agent_inferred"),
      provenance: {},
      createdTaskId: a.createdTaskId,
    },
    db,
  );
  return { id: note.id, handle: handles.mint({ kind: "n", spaceId: PS, nodeId: note.id }) };
};

const nodeDeletedAt = async (id: string) =>
  (await q(`SELECT deleted_at FROM vault_nodes WHERE id = $1`, [id])).rows[0].deleted_at as Date | null;

const supersededAt = async (id: string) =>
  (await q(`SELECT superseded_at FROM vault_claims WHERE id = $1`, [id])).rows[0].superseded_at as Date | null;

const versionCount = async (noteId: string) =>
  Number((await q(`SELECT count(*) AS c FROM vault_note_versions WHERE note_id = $1`, [noteId])).rows[0].c);

const auditActions = async (subjectId: string) =>
  (await q(`SELECT action FROM audit_events WHERE subject_id = $1`, [subjectId])).rows.map((r) => r.action as string);

const projectionRows = async (nodeId: string) =>
  Number((await q(`SELECT count(*) AS c FROM vault_search_documents WHERE node_id = $1`, [nodeId])).rows[0].c);

run("memory_forget", () => {
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
    await q(`DELETE FROM audit_events WHERE space_id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
  });

  it("soft-deletes only a node whose created_task_id equals THIS run's taskId", async () => {
    const mine = await seedClaim({ createdTaskId: TASK });
    const r = await memoryForget({ handle: mine.handle, expectedRevision: 1, ctx: ctx() });
    expect(r.status).toBe("forgotten");
    expect(await nodeDeletedAt(mine.id)).not.toBeNull();
    // The whole terminal state, not just the tombstone: the chain has no active head, the
    // edges are closed and the projection row is gone, which is what `deleteNode` owns.
    expect(await supersededAt(mine.id)).not.toBeNull();
    expect(await projectionRows(mine.id)).toBe(0);
    expect(await auditActions(mine.id)).toContain("claim.forget");
  });

  it("THE BOUND IS A COLUMN COMPARISON IN THE DB WRITE, not the handle map", async () => {
    // A legitimately obtained handle for an older row must still fail, and it must fail in
    // the statement — reachability is not authority.
    const theirs = await seedClaim({ createdTaskId: "an-earlier-task" });
    const r = await memoryForget({ handle: theirs.handle, expectedRevision: 1, ctx: ctx() });
    expect(r.status).toBe("requires_owner_ui");
    expect(r.said).toContain("memory page");
    expect(await nodeDeletedAt(theirs.id)).toBeNull();
    // NOTHING moved: not the tombstone, not the head, not the projection.
    expect(await supersededAt(theirs.id)).toBeNull();
    expect(await projectionRows(theirs.id)).toBe(1);
    expect(await auditActions(theirs.id)).not.toContain("claim.forget");
  });

  it("a row with NO created_task_id is nobody's to undo", async () => {
    // The owner's own write, and every row that predates the column. `NULL = 'task'` is
    // never true in SQL, so the bound refuses it by construction rather than by a branch —
    // which is the property that makes an unlisted writer safe here instead of dangerous.
    const ownerWrote = await seedClaim({});
    const r = await memoryForget({ handle: ownerWrote.handle, expectedRevision: 1, ctx: ctx() });
    expect(r.status).toBe("requires_owner_ui");
    expect(await nodeDeletedAt(ownerWrote.id)).toBeNull();
  });

  it("the OTHER half of an approval turn cannot reach the first half's writes (§4.1, L8)", async () => {
    // Stated in the spec and asserted here so nobody re-derives it as a bug: a continuation
    // is a SECOND task with its own `makeVaultMemoryTools` call, so the bound does not reach
    // what the first half wrote. The handle would be void too; this drives the bound directly
    // by keeping the handle and changing the task.
    const firstHalf = await seedClaim({ createdTaskId: `${TASK}-half-1` });
    const r = await memoryForget({ handle: firstHalf.handle, expectedRevision: 1, ctx: ctx({ taskId: `${TASK}-half-2` }) });
    expect(r.status).toBe("requires_owner_ui");
    expect(await nodeDeletedAt(firstHalf.id)).toBeNull();
  });

  it("undoes a NOTE this task wrote, head version and all", async () => {
    const written = await noteWrite({
      op: { kind: "create", scope: "project" },
      title: "Deadlines",
      content: [{ kind: "markdown", text: "the fifteenth" }],
      grounding: { kind: "agent_inference" },
      ctx: ctx(),
    });
    if (written.status !== "created") throw new Error(`expected created, got ${written.status}`);
    const noteId = handles.resolve(written.handle)!.nodeId;

    const r = await memoryForget({ handle: written.handle, expectedRevision: 1, ctx: ctx() });
    expect(r.status).toBe("forgotten");
    expect(await nodeDeletedAt(noteId)).not.toBeNull();
    // The VERSION survives — content is immutable and the node's tombstone is what removes
    // the note from every list and from the graph (§2.5).
    expect(await versionCount(noteId)).toBe(1);
    expect(await projectionRows(noteId)).toBe(0);
    expect(await auditActions(noteId)).toContain("node.delete");
    // The `contains` edge that filed it is closed with it.
    const { rows } = await q(
      `SELECT count(*) AS c FROM vault_edges WHERE to_node_id = $1 AND deleted_at IS NULL`,
      [noteId],
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it("a NOTE whose head version another task wrote is refused, and the note survives", async () => {
    const theirs = await seedNote({ createdTaskId: "an-earlier-task" });
    const r = await memoryForget({ handle: theirs.handle, expectedRevision: 1, ctx: ctx() });
    expect(r.status).toBe("requires_owner_ui");
    expect(await nodeDeletedAt(theirs.id)).toBeNull();
    expect(await auditActions(theirs.id)).not.toContain("node.delete");
  });

  it("a stale revision is a revision_mismatch, not a refused bound", async () => {
    // The two failures are distinguished on purpose: a revision the model can re-read beats
    // a bound it cannot cross, and reporting the second for the first would tell a person
    // their own note is un-deletable when they simply held an old number.
    const mine = await seedClaim({ createdTaskId: TASK });
    const r = await memoryForget({ handle: mine.handle, expectedRevision: 4, ctx: ctx() });
    expect(r).toMatchObject({ status: "revision_mismatch", revision: 1 });
    expect(await nodeDeletedAt(mine.id)).toBeNull();

    const note = await seedNote({ createdTaskId: TASK });
    expect(await memoryForget({ handle: note.handle, expectedRevision: 9, ctx: ctx() })).toMatchObject({
      status: "revision_mismatch",
      revision: 1,
    });
    expect(await nodeDeletedAt(note.id)).toBeNull();
  });

  it("refuses f, e and g handles with the sentence that says who can", async () => {
    // `knowledge_sources` and `vault_edges` carry no `created_task_id`, which is why these
    // are refused rather than CHECKED: a bound that cannot be expressed must not be implied.
    const f = handles.mint({ kind: "f", spaceId: PS, nodeId: `${P}source` });
    const fr = await memoryForget({ handle: f, expectedRevision: 1, ctx: ctx() });
    expect(fr.status).toBe("wrong_kind");
    expect(fr.said).toMatch(/owner/);

    for (const kind of ["e", "g"] as const) {
      const h = handles.mint({ kind, spaceId: PS, nodeId: `${P}${kind}` });
      const r = await memoryForget({ handle: h, expectedRevision: 1, ctx: ctx() });
      expect(r.status, kind).toBe("wrong_kind");
      expect(r.said, kind).toMatch(/not removable on their own/);
    }
  });

  it("a handle from another space, a fabricated one and a retired space all remove nothing", async () => {
    const OTHER = `${P}space-someone-else`;
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [OTHER, `${P}u2`]);
    // A REAL row in a REAL third space, written by THIS task — so only the space fence can
    // refuse it, and a fabricated node id would have been refused for the wrong reason.
    const theirs = await seedClaim({ spaceId: OTHER, createdTaskId: TASK });
    expect((await memoryForget({ handle: theirs.handle, expectedRevision: 1, ctx: ctx() })).status).toBe("not_found");
    expect(await nodeDeletedAt(theirs.id)).toBeNull();

    expect((await memoryForget({ handle: "m99", expectedRevision: 1, ctx: ctx() })).status).toBe("not_found");

    const mine = await seedClaim({ createdTaskId: TASK });
    await q(`UPDATE spaces SET retired_at = now() WHERE id = $1`, [PS]);
    expect((await memoryForget({ handle: mine.handle, expectedRevision: 1, ctx: ctx() })).status).toBe("retired");
    expect(await nodeDeletedAt(mine.id)).toBeNull();
  });
});

run("memory_forget fixtures", () => {
  it("leaves no prefixed rows behind", async () => {
    await db.transaction(async () => {});
    const { rows } = await q(`SELECT count(*) AS c FROM spaces WHERE id LIKE $1`, [`${P}%`]);
    expect(Number(rows[0].c)).toBe(0);
    const audit = await q(`SELECT count(*) AS c FROM audit_events WHERE space_id LIKE $1`, [`${P}%`]);
    expect(Number(audit.rows[0].c)).toBe(0);
  });
});
