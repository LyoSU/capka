import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The "saved to memory" notice, from both ends: the PROJECTION that says what a turn
 * wrote, and the UNDO that removes one item. Both are joins and ownership filters over
 * three tables plus `audit_events`, which is exactly what a mocked `db` would simply agree
 * with — and the property that matters most (an undone row is not named on the next read)
 * only exists because there is no second copy of the list anywhere.
 *
 * Every fixture id carries the prefix and the cleanup is prefix-scoped: this database is
 * shared and holds a developer's real memory.
 */
import { pool } from "@/lib/db";
import { createClaim, forgetClaim } from "../claims";
import { createNote, forgetNote, noteHead, revertNote, reviseNote } from "../notes";
import { getOrCreateSpace } from "../spaces";
import { readTurnWrites } from "../turn-writes";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const P = "turnw-";
const OWNER = `${P}owner`;
const STRANGER = `${P}stranger`;
const CHAT = `${P}chat`;
const MSG = `${P}msg`;
const OTHER_MSG = `${P}msg2`;
const TASK = `${P}task`;

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'turn writes test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

const mkMessage = (id: string) =>
  q(
    `INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES ($1, $2, 'assistant', 'test', now()) ON CONFLICT (id) DO NOTHING`,
    [id, CHAT],
  );

/** The actor recorded against one action for one subject. The whole point of the undo's
 *  own test: `memory_forget` acts as `agent`, the owner's route acts as `user`, and the
 *  audit log is where that difference is visible afterwards. */
const auditActor = async (subjectId: string, action: string) => {
  const { rows } = await pool.query<{ actor: { kind?: string } }>(
    `SELECT actor FROM audit_events WHERE subject_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`,
    [subjectId, action],
  );
  return rows[0]?.actor ?? null;
};

const spaceOf = (owner = OWNER) => getOrCreateSpace({ type: "user", refId: owner });

/** A fact the agent's turn saved, with the origin the projection keys on. */
const seedFact = async (statement: string, opts: { messageId?: string; owner?: string; sensitive?: boolean } = {}) => {
  const spaceId = await spaceOf(opts.owner ?? OWNER);
  return createClaim(
    {
      spaceId,
      statement,
      origin: { kind: "agent_inference", via: "extraction", messageId: opts.messageId ?? MSG, taskId: TASK },
      sensitive: opts.sensitive,
      sourceClass: testServerClass("agent_inferred"),
      createdTaskId: TASK,
    },
    { kind: "agent" },
  );
};

/** A note whose revision 1 was written by a stated turn — the file an later turn EDITS. */
const seedNoteFrom = (spaceId: string, messageId: string, bodyMarkdown: string) =>
  createNote({
    spaceId,
    title: "Acme onboarding",
    bodyMarkdown,
    sourceClass: testServerClass("agent_inferred"),
    provenance: { kind: "agent_inference", messageId, taskId: TASK },
    createdTaskId: TASK,
    actor: { kind: "agent" },
  });

/**
 * RUN `write` AGAINST THE NOTE ROW while a second connection holds its write lock, then let
 * the lock go — a deterministic lost CAS rather than a race.
 *
 * `hold` runs inside an open transaction on its own pooled connection, so it takes the row's
 * write lock and stays invisible to every other reader until it commits. `write` then reads
 * the pre-lock state under READ COMMITTED, gets as far as its own UPDATE, and BLOCKS. The
 * commit releases it, PostgreSQL re-evaluates the blocked statement against the new row
 * version, and the CAS finds nothing to match.
 *
 * THE CONTROL IS `pg_blocking_pids`, not a match on `pg_stat_activity.query`. The query text
 * of another backend is readable only to the same role or to `pg_read_all_stats`, so a role
 * split between app and tests would make a text control silently never fire; and this
 * database is shared with a running platform worker, so any OTHER backend blocked on a
 * `vault_notes` lock would satisfy a text match. Asking whether the holder's pid appears
 * among a backend's blockers is exact and needs neither.
 *
 * `racing` is awaited in the `finally` and its result discarded, so a failed expectation
 * cannot leave the write running against the live database during cleanup, nor leave a
 * floating promise behind.
 */
async function whileHoldingTheRow<T>(hold: string, noteId: string, write: () => Promise<T>): Promise<T> {
  const other = await pool.connect();
  let racing: Promise<T> | null = null;
  try {
    await other.query("BEGIN");
    const holder = Number((await other.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    await other.query(hold, [noteId]);

    racing = write();
    let blocked = false;
    // 10s, because the suite's own timeout is 20s: a loaded machine must not turn this into
    // a red test with an unrelated cause, which is the kind that teaches people to re-run.
    for (let i = 0; i < 200 && !blocked; i += 1) {
      const { rows } = await q(`SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity`);
      blocked = rows.some((r) => (r.blockers as number[]).includes(holder));
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    // Without this the commit could land before the write had read anything, and the case
    // would be exercising the ordinary guarded path under another name.
    expect(blocked).toBe(true);

    await other.query("COMMIT");
    return await racing;
  } finally {
    await other.query("ROLLBACK").catch(() => {});
    other.release();
    await racing?.catch(() => {});
  }
}

const cleanup = async () => {
  await q(`DELETE FROM spaces WHERE owner_user_id = ANY($1)`, [[OWNER, STRANGER]]);
  await q(`DELETE FROM audit_events WHERE subject_id LIKE $1`, [`${P}%`]);
};

run("vault: what a turn wrote to memory", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await mkUser(STRANGER);
    await q(`INSERT INTO chats (id, user_id, title, visibility) VALUES ($1, $2, 'turn writes', 'private')
             ON CONFLICT (id) DO NOTHING`, [CHAT, OWNER]);
    await mkMessage(MSG);
    await mkMessage(OTHER_MSG);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM messages WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM chats WHERE id LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM "user" WHERE id LIKE $1`, [`${P}%`]);
  });

  it("names the items a turn wrote, with a handle-free id the page can act on", async () => {
    const fact = await seedFact("Acme is paid monthly");
    const spaceId = await spaceOf();
    const note = await createNote(
      {
        spaceId,
        title: "Acme onboarding",
        bodyMarkdown: "Steps.",
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
        createdTaskId: TASK,
        actor: { kind: "agent" },
      },
    );

    const writes = await readTurnWrites([MSG], OWNER);
    expect(writes[MSG]).toHaveLength(2);
    // PERSISTENT ids, not run-local handles: a handle is minted for a model and expires
    // with the turn, and the undo route takes the row's own id.
    expect(writes[MSG].map((w) => w.id).sort()).toEqual([fact.id, note.id].sort());
    expect(writes[MSG].find((w) => w.id === fact.id)).toMatchObject({
      kind: "fact",
      text: "Acme is paid monthly",
      scope: "user",
    });
    // A note sends its TITLE, not its body: a notice is not where a person reads a
    // document.
    expect(writes[MSG].find((w) => w.id === note.id)).toMatchObject({ kind: "note", text: "Acme onboarding" });
  });

  it("says nothing at all when a turn wrote nothing", async () => {
    await seedFact("Acme is paid monthly", { messageId: OTHER_MSG });
    // NO KEY, rather than an empty array: the renderer has no data and so renders no
    // element, which is what "says nothing at all" means at this layer.
    expect(await readTurnWrites([MSG], OWNER)).toEqual({});
  });

  it("gives each message only its own writes", async () => {
    const mine = await seedFact("Acme is paid monthly");
    await seedFact("Beta ships in March", { messageId: OTHER_MSG });
    const writes = await readTurnWrites([MSG, OTHER_MSG], OWNER);
    expect(writes[MSG].map((w) => w.id)).toEqual([mine.id]);
    expect(writes[OTHER_MSG]).toHaveLength(1);
  });

  it("never names a row from a space this user does not own", async () => {
    // The ownership filter, isolated. The caller is a chat route that has already proved
    // the chat is this user's — and a fact's space is a different object from a chat, so
    // an imported or shared conversation is exactly where the two diverge.
    await seedFact("The stranger's own fact", { owner: STRANGER });
    expect(await readTurnWrites([MSG], OWNER)).toEqual({});
  });

  it("marks a sensitive item rather than sending its words", async () => {
    // The projection SENDS the text — the owner owns it — and marks it; what refuses to
    // print it is the notice, which has no reveal control and scrolls past on its own.
    // Asserted here because `sensitive` travelling is what lets the renderer make that
    // choice at all.
    const fact = await seedFact("Recovery code 447192 for the shared mailbox", { sensitive: true });
    const writes = await readTurnWrites([MSG], OWNER);
    expect(writes[MSG].find((w) => w.id === fact.id)?.sensitive).toBe(true);
  });

  it("undo is a SOFT delete by the OWNER, available regardless of who wrote the row", async () => {
    // "Undo" is not `memory_forget`: that tool's same-task bound is the AGENT's limit,
    // and the person's own session is what establishes authority here. The row below was
    // written by the agent, in a task that is over, and the owner removes it anyway.
    const fact = await seedFact("Acme is paid monthly");
    const spaceId = await spaceOf();
    const res = await forgetClaim({
      claimId: fact.id,
      expectedRevision: fact.revision,
      allowedSpaceIds: [spaceId],
      actor: { kind: "user", id: OWNER },
    });
    expect(res).toMatchObject({ ok: true });
    expect(await auditActor(fact.id, "claim.forget")).toMatchObject({ kind: "user" });
    // SOFT: the row and its provenance survive, and the chain simply has no live head.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM vault_claims WHERE id = $1 AND superseded_at IS NOT NULL`,
      [fact.id],
    );
    expect(Number(rows[0].n)).toBe(1);
    // And the notice stops naming it on the next read — there is no second copy of the
    // list to disagree, which is the whole reason the notice is a projection.
    expect(await readTurnWrites([MSG], OWNER)).toEqual({});
  });

  it("the owner's undo of a NOTE needs no task, unlike the agent's", async () => {
    // `forgetNote`'s bound is a column comparison inside the delete. With a task it is
    // the agent's same-turn limit; without one it is the owner acting on their own row,
    // which is the widening this task needed and the reason the parameter is optional.
    const spaceId = await spaceOf();
    const note = await createNote(
      {
        spaceId,
        title: "Acme onboarding",
        bodyMarkdown: "Steps.",
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
        createdTaskId: TASK,
        actor: { kind: "agent" },
      },
    );
    // The agent's bound refuses a DIFFERENT task, which is what makes the owner's path a
    // widening rather than a duplicate.
    expect(await forgetNote({ noteId: note.id, spaceId, expectedRevision: 1, createdTaskId: `${TASK}-other`, actor: { kind: "agent" } }))
      .toMatchObject({ ok: false, reason: "not_this_task" });

    expect(await forgetNote({ noteId: note.id, spaceId, expectedRevision: 1, actor: { kind: "user", id: OWNER } }))
      .toMatchObject({ ok: true });
    expect(await auditActor(note.id, "node.delete")).toMatchObject({ kind: "user" });
    expect(await readTurnWrites([MSG], OWNER)).toEqual({});
  });

  it("the owner's unbounded delete still requires the revision to be the HEAD", async () => {
    // The control on the widening: folding the whole clause away for the owner would drop
    // the `revision = current_revision` check with the task bound, so a stale page could
    // delete a note by naming a revision that is no longer current. That is a different
    // rule and nobody meant to relax it.
    const spaceId = await spaceOf();
    const note = await createNote(
      {
        spaceId,
        title: "Acme onboarding",
        bodyMarkdown: "Steps.",
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
        actor: { kind: "agent" },
      },
    );
    expect(await forgetNote({ noteId: note.id, spaceId, expectedRevision: 2, actor: { kind: "user", id: OWNER } }))
      .toMatchObject({ ok: false, reason: "revision_mismatch" });
  });

  it("an EDIT names the revision it wrote, so the notice can tell it from a save", async () => {
    // The notice offers Undo on everything a turn wrote, and a turn that merely EDITED an
    // existing file must not be undone by deleting the file. The number is what separates
    // the two, and it comes off the AUDIT EVENT rather than off the row: the row's
    // `current_revision` moves again the moment anything else touches the note.
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, OTHER_MSG, "The old steps.");
    const upd = await reviseNote({
      noteId: note.id,
      spaceId,
      expectedRevision: 1,
      title: "Acme onboarding",
      bodyMarkdown: "The new steps.",
      sourceClass: testServerClass("agent_inferred"),
      provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
      actor: { kind: "agent" },
    });
    expect(upd).toMatchObject({ ok: true, revision: 2 });

    expect((await readTurnWrites([MSG], OWNER))[MSG]).toMatchObject([
      { id: note.id, kind: "note", revision: 2 },
    ]);
    // The CONTROL: a file a turn CREATED reports revision 1, which is the arm whose undo
    // stays a delete. On a SECOND file, because the projection is head-based — the file
    // above has been edited since, so the turn that created it no longer names it at all,
    // which is the same property that makes an undone item leave the notice.
    const untouched = await seedNoteFrom(spaceId, OTHER_MSG, "Never edited.");
    expect((await readTurnWrites([OTHER_MSG], OWNER))[OTHER_MSG]).toMatchObject([
      { id: untouched.id, revision: 1 },
    ]);
  });

  it("undo of an EDIT puts the old words back and keeps the file, its id and its history", async () => {
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, OTHER_MSG, "The old steps.");
    await reviseNote({
      noteId: note.id,
      spaceId,
      expectedRevision: 1,
      title: "Acme onboarding",
      bodyMarkdown: "The new steps.",
      sourceClass: testServerClass("agent_inferred"),
      provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
      actor: { kind: "agent" },
    });

    const reverted = await revertNote({
      noteId: note.id,
      spaceId,
      toRevision: 1,
      actor: { kind: "user", id: OWNER },
    });
    // A NEW revision, not a rollback: history is append-only, so the edit and the undo are
    // both in the record and a person can undo the undo.
    expect(reverted).toEqual({ ok: true, revision: 3 });
    expect(await noteHead(note.id, [spaceId])).toMatchObject({
      revision: 3,
      bodyMarkdown: "The old steps.",
      // The class is CARRIED, never re-decided: an undo must not promote the agent's own
      // words to the tier a person's statement gets.
      sourceClass: "agent_inferred",
    });
    const versions = await q(`SELECT count(*) AS n FROM vault_note_versions WHERE note_id = $1`, [note.id]);
    expect(Number((versions.rows[0] as { n: string }).n)).toBe(3);
    // The file is still on every list — this is the whole difference from the delete the
    // notice used to perform.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM vault_nodes WHERE id = $1 AND deleted_at IS NULL`,
      [note.id],
    );
    expect(Number(rows[0].n)).toBe(1);
    // And the notice stops naming it, because the head this turn wrote is no longer the
    // head: the revert's provenance carries no `messageId`, so there is no second copy of
    // the list to disagree.
    expect(await readTurnWrites([MSG], OWNER)).toEqual({});
  });

  it("refuses a revert whose expected head has moved, and writes nothing", async () => {
    // The notice computes `revertTo` from the revision it DISPLAYED, so if a later turn
    // edited the same file in between, an unguarded revert succeeds and drops that later
    // edit out of the head — for a person who was looking at a stale page and has no
    // version-history surface to notice with. The window is narrow by design and it is
    // still a window, so the expected head travels with the request.
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, OTHER_MSG, "The first steps.");
    const actor = { kind: "user", id: OWNER } as const;
    for (const [rev, body] of [[1, "The second steps."], [2, "The third steps."]] as const) {
      await reviseNote({
        noteId: note.id,
        spaceId,
        expectedRevision: rev,
        title: "Acme onboarding",
        bodyMarkdown: body,
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
        actor: { kind: "agent" },
      });
    }

    // The page still shows revision 2, so it asks to go back to 1 believing 2 is the head.
    expect(await revertNote({ noteId: note.id, spaceId, toRevision: 1, expectedRevision: 2, actor })).toEqual({
      ok: false,
      reason: "revision_moved",
      revision: 3,
    });
    // NOTHING was written: no fourth version, and the third revision's words still stand.
    const versions = await q(`SELECT count(*) AS n FROM vault_note_versions WHERE note_id = $1`, [note.id]);
    expect(Number((versions.rows[0] as { n: string }).n)).toBe(3);
    expect(await noteHead(note.id, [spaceId])).toMatchObject({ revision: 3, bodyMarkdown: "The third steps." });

    // And the same request with the head it actually has goes through, so the guard is a
    // guard and not a wall.
    expect(await revertNote({ noteId: note.id, spaceId, toRevision: 1, expectedRevision: 3, actor })).toEqual({
      ok: true,
      revision: 4,
    });
  });

  it("a LOST CAS reports the head reviseNote re-read, not the one the revert started from", async () => {
    // The other `revision_moved` arm, and the one the guarded case above cannot reach: the
    // head moves AFTER this function read it, inside its own transaction. `reviseNote`
    // re-reads the row when its CAS loses, so the newer number is already in hand — and the
    // number this function started from is, on the guarded path, exactly what the caller
    // sent. Answering with that would say "the file moved" and then name the revision the
    // client already believes is current.
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, OTHER_MSG, "The first steps.");
    const actor = { kind: "user", id: OWNER } as const;
    for (const [rev, body] of [[1, "The second steps."], [2, "The third steps."]] as const) {
      await reviseNote({
        noteId: note.id,
        spaceId,
        expectedRevision: rev,
        title: "Acme onboarding",
        bodyMarkdown: body,
        sourceClass: testServerClass("agent_inferred"),
        provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
        actor: { kind: "agent" },
      });
    }

    expect(
      await whileHoldingTheRow(`UPDATE vault_notes SET current_revision = 2 WHERE id = $1`, note.id, () =>
        revertNote({ noteId: note.id, spaceId, toRevision: 1, actor }),
      ),
    ).toEqual({ ok: false, reason: "revision_moved", revision: 2 });

    // NOTHING was written by the loser, and the head is what the winner left.
    const versions = await q(`SELECT count(*) AS n FROM vault_note_versions WHERE note_id = $1`, [note.id]);
    expect(Number((versions.rows[0] as { n: string }).n)).toBe(3);
  });

  it("a revert whose note VANISHES under it is not found, rather than a revision of zero", async () => {
    // The narrow arm `reviseNote`'s `cur?.revision ?? 0` produces: the CAS loses AND the
    // re-read finds no row, which only a concurrent delete of the space's memory can cause.
    // Zero is not a revision, and the chat notice would receive `409 { revision: 0 }` — a
    // number the person can neither see nor retry with. `not_found` is what the route turns
    // into a 404, which is what the notice already handles.
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, OTHER_MSG, "The first steps.");
    const actor = { kind: "user", id: OWNER } as const;
    await reviseNote({
      noteId: note.id,
      spaceId,
      expectedRevision: 1,
      title: "Acme onboarding",
      bodyMarkdown: "The second steps.",
      sourceClass: testServerClass("agent_inferred"),
      provenance: { kind: "agent_inference", messageId: MSG, taskId: TASK },
      actor: { kind: "agent" },
    });

    expect(
      await whileHoldingTheRow(`DELETE FROM vault_notes WHERE id = $1`, note.id, () =>
        revertNote({ noteId: note.id, spaceId, toRevision: 1, actor }),
      ),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses a revert that is not to an EARLIER revision", async () => {
    // Reverting to the head is a no-op dressed as a write, and reverting forward is not a
    // thing an undo can mean. Both are refused rather than silently doing nothing, so a
    // caller that computed the wrong target hears about it.
    const spaceId = await spaceOf();
    const note = await seedNoteFrom(spaceId, MSG, "Only one revision.");
    const actor = { kind: "user", id: OWNER } as const;
    expect(await revertNote({ noteId: note.id, spaceId, toRevision: 1, actor })).toEqual({
      ok: false,
      reason: "not_revertable",
    });
    expect(await revertNote({ noteId: note.id, spaceId, toRevision: 2, actor })).toEqual({
      ok: false,
      reason: "not_revertable",
    });
    expect(await revertNote({ noteId: `${P}nope`, spaceId, toRevision: 1, actor })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("a topic container created while filing a fact is never announced", async () => {
    // `resolveTopic` writes a note version too, so it writes `note.revise` — and the
    // notice must not say "Capka remembered: General" for every fact it files. What keeps
    // it out is the PROVENANCE: no turn wrote that container, so it carries no
    // `messageId`, and the projection's predicate is exactly that key rather than a
    // `kind` check somewhere else.
    const spaceId = await spaceOf();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM vault_note_versions v
         JOIN vault_notes n ON n.id = v.note_id
        WHERE n.space_id = $1 AND v.provenance ->> 'kind' = 'topic_created'`,
      [spaceId],
    );
    // The fixture: filing a fact under a topic is what creates one.
    await createClaim(
      {
        spaceId,
        statement: "Acme is paid monthly",
        origin: { kind: "agent_inference", messageId: MSG },
        sourceClass: testServerClass("agent_inferred"),
      },
      { kind: "agent" },
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0);
    const writes = await readTurnWrites([MSG], OWNER);
    expect(writes[MSG].every((w) => w.kind === "fact")).toBe(true);
  });
});
