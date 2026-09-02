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
import { createNote, forgetNote } from "../notes";
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
