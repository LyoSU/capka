import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * Space resolvers and the owner lifecycle. Nothing is mocked: both get-or-creates
 * exist ONLY for the race on a unique index, and the whole point of retire/purge
 * is which rows Postgres removes by cascade and where a citation's RESTRICT rolls
 * the transaction back. Any in-memory double here would be testing its own
 * imagination rather than the database.
 */
import { eq } from "drizzle-orm";
import { db, pool } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  DEFAULT_TOPIC_KEY,
  getOrCreateSpace,
  getOrCreateTopicNote,
  retireProjectSpace,
  purgeUserSpaces,
  type Ex,
} from "../spaces";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix, so cleanup is one LIKE per table.
 *  Space ids are not ours to choose (nanoid, from the inside), so those are caught
 *  by owner_user_id instead. */
const P = "spctest-";
const OWNER = `${P}owner`;
const CHAT = `${P}chat`;
const MSG = `${P}msg`;
const PROJ = `${P}proj`;

const FK_VIOLATION = "23503";

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

/** users.email is unique too — a targeted ON CONFLICT (id) would raise 23505 on a
 *  leftover row with the same email, which reads like a skipped test. */
const mkUser = (id: string) =>
  q(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'spaces test', $2, true, now(), now()) ON CONFLICT DO NOTHING`,
    [id, `${id}@test.local`],
  );

/** The full source→version→fragment chain under a space. */
const mkChain = async (spaceId: string, tag: string) => {
  const source = `${P}${tag}-src`;
  const version = `${P}${tag}-ver`;
  const fragment = `${P}${tag}-frag`;
  await seedNode(source, spaceId, "source");
  await q(
    `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by)
     VALUES ($1, $2, 'fixture', '{"type":"upload"}'::jsonb, $3)`,
    [source, spaceId, OWNER],
  );
  await q(`INSERT INTO knowledge_source_versions (id, source_id, sha256) VALUES ($1, $2, $3)`, [
    version,
    source,
    "a".repeat(64),
  ]);
  await q(
    `INSERT INTO knowledge_fragments (id, version_id, ordinal, text, locator)
     VALUES ($1, $2, 0, 'fixture fragment', '{"scheme":"char"}'::jsonb)`,
    [fragment, version],
  );
  return { source, version, fragment };
};

/** The citation is made by hand: minting belongs to plan C, but the pin is needed
 *  here already. */
const mkCitation = async (tag: string, versionId: string, fragmentId: string) => {
  const id = `${P}${tag}-cit`;
  await q(
    `INSERT INTO message_citations
       (id, message_id, ordinal, source_version_id, fragment_id, quote_snapshot, locator_snapshot, title_snapshot)
     VALUES ($1, $2, 1, $3, $4, 'quoted text', '{"scheme":"char"}'::jsonb, 'fixture')`,
    [id, MSG, versionId, fragmentId],
  );
  return id;
};

const mkClaim = async (id: string, spaceId: string) => {
  await seedNode(id, spaceId, "claim");
  await q(
    `INSERT INTO vault_claims (id, space_id, statement, origin, source_class)
     VALUES ($1, $2, 'a fact', '{}'::jsonb, 'agent_inferred')`,
    [id, spaceId],
  );
};

const retireEvents = (spaceId: string) => count("audit_events", "space_id = $1 AND action = 'space.retire'", [spaceId]);

/** A handle whose FIRST `select` resolves empty without touching the database, and
 *  whose every other call reaches the real one. That is exactly what the LOSER of the
 *  get-or-create race sees: it reads nothing, its `ON CONFLICT DO NOTHING` insert
 *  writes nothing, and the row it finally reads back is the WINNER's. Reproducing
 *  that with two live callers is a coin flip — whichever finishes first returns from
 *  the first read and never exercises the second one — so the window is made
 *  deterministic here instead. A proxy rather than a spy: drizzle keeps internal
 *  fields under symbols, so exactly one method is swapped and the rest is untouched. */
const blindFirstRead = (): Ex => {
  let first = true;
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop !== "select" || !first) return typeof value === "function" ? value.bind(target) : value;
      first = false;
      const chain: Record<string, unknown> = {};
      for (const step of ["from", "where", "limit"]) chain[step] = () => chain;
      chain.then = (onOk: (rows: unknown[]) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve([]).then(onOk, onErr);
      return () => chain;
    },
  }) as Ex;
};

const cleanup = async () => {
  // Citations pin the cascade, so they go first — the same order the product has
  // to hold.
  await q(`DELETE FROM message_citations WHERE id LIKE $1`, [`${P}%`]);
  await q(`DELETE FROM spaces WHERE owner_user_id LIKE $1`, [`${P}%`]);
  // Subject users are created inside the tests; OWNER lives until afterAll.
  await q(`DELETE FROM "user" WHERE id LIKE $1 AND id <> $2`, [`${P}%`, OWNER]);
};

run("vault spaces", () => {
  beforeAll(async () => {
    await mkUser(OWNER);
    await q(`INSERT INTO chats (id, user_id, title) VALUES ($1, $2, 'spaces test') ON CONFLICT (id) DO NOTHING`, [
      CHAT,
      OWNER,
    ]);
    await q(
      `INSERT INTO messages (id, chat_id, role, content) VALUES ($1, $2, 'assistant', 'hi')
         ON CONFLICT (id) DO NOTHING`,
      [MSG, CHAT],
    );
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM chats WHERE id = $1`, [CHAT]); // messages → citations by cascade
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });

  beforeEach(cleanup);

  it("concurrent getOrCreateSpace yields EXACTLY one space", async () => {
    const ids = await Promise.all([
      getOrCreateSpace({ type: "user", refId: OWNER }),
      getOrCreateSpace({ type: "user", refId: OWNER }),
      getOrCreateSpace({ type: "user", refId: OWNER }),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(await count("spaces", "type = 'user' AND ref_id = $1", [OWNER])).toBe(1);
    // For a user space the owner IS the refId (a project space takes ownerUserId
    // from the caller).
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [ids[0], OWNER])).toBe(1);
  });

  it("a project space records the owner it was passed, not its own refId", async () => {
    const id = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    expect(await count("spaces", "id = $1 AND type = 'project' AND ref_id = $2 AND owner_user_id = $3", [id, PROJ, OWNER])).toBe(1);
  });

  it("an existing project space with a DIFFERENT owner is refused, never quietly reused", async () => {
    // Whoever calls first pins `owner_user_id`, and every later lookup goes by
    // (type, ref_id). Without this check a single wrong first call would leave the
    // project's knowledge outside its real owner's `purgeUserSpaces` FOREVER, with
    // nothing anywhere saying so.
    const stranger = `${P}stranger`;
    await mkUser(stranger);
    const id = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });

    await expect(getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: stranger })).rejects.toThrow(/owner/i);

    // Refusing leaves the row exactly as it was: the mismatch is a caller bug, and
    // rewriting the owner on its say-so would hand a whole space to the wrong user.
    expect(await count("spaces", "id = $1 AND owner_user_id = $2", [id, OWNER])).toBe(1);
    // The matching owner still resolves to the same space, so the guard costs nothing
    // on the hot path it sits on.
    expect(await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER })).toBe(id);
  });

  it("the race LOSER's re-read is checked too, so the winner's owner is not adopted", async () => {
    // The second read is a separate return path, and the ONLY one a concurrent caller
    // takes. Left unchecked it reopens the whole hole under exactly the conditions
    // this function exists for: the loser reads back a row it never wrote and hands
    // its caller a space owned by someone else.
    const stranger = `${P}race-stranger`;
    await mkUser(stranger);
    const raceProj = `${P}race-proj`;
    // The "winner" is already committed; the stubbed first read is what makes our
    // caller take the insert-then-re-read path anyway.
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $2, $3)`, [
      `${P}race-space`,
      raceProj,
      stranger,
    ]);

    await expect(
      getOrCreateSpace({ type: "project", refId: raceProj, ownerUserId: OWNER }, blindFirstRead()),
    ).rejects.toThrow(/owned by/);

    // The insert really did run and really did no-op: one row, still the winner's.
    expect(await count("spaces", "type = 'project' AND ref_id = $1", [raceProj])).toBe(1);
    expect(await count("spaces", "ref_id = $1 AND owner_user_id = $2", [raceProj, stranger])).toBe(1);
  });

  it("concurrent getOrCreateTopicNote yields EXACTLY one topic", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const notes = await Promise.all([
      getOrCreateTopicNote(spaceId, "Work"),
      getOrCreateTopicNote(spaceId, "Work"),
      getOrCreateTopicNote(spaceId, "Work"),
    ]);
    expect(new Set(notes).size).toBe(1);
    expect(await count("vault_notes", "space_id = $1 AND title = 'Work'", [spaceId])).toBe(1);
    // Title uniqueness is partial, scoped to kind='memory_topic', so a topic has to
    // be created with exactly that kind or the index does not see it.
    expect(await count("vault_notes", "id = $1 AND kind = 'memory_topic'", [notes[0]])).toBe(1);
    // This is also the only place the node co-write's race LOSER is reached: two of the
    // three calls mint a node and then lose the `onConflictDoNothing`, so the cleanup that
    // removes their node is what keeps these two counts equal. Without it: 3 against 1.
    // Sequential calls cannot witness this — the second one returns at the early read and
    // never inserts anything.
    expect(await count("vault_nodes", "space_id = $1 AND kind = 'note'", [spaceId])).toBe(
      await count("vault_notes", "space_id = $1", [spaceId]),
    );
  });

  it("retire: a project's memory dies, its sources/versions/fragments/citation live", async () => {
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    const noteId = await getOrCreateTopicNote(spaceId, "Project topic");
    const claim = `${P}claim`;
    await mkClaim(claim, spaceId);
    await q(`INSERT INTO note_claims (note_id, claim_id) VALUES ($1, $2)`, [noteId, claim]);
    await q(`INSERT INTO claim_evidence (id, claim_id) VALUES ($1, $2)`, [`${P}ev`, claim]);
    await q(
      `INSERT INTO memory_candidates (id, idempotency_key, space_id, statement, provenance, policy_state)
       VALUES ($1, $1, $2, 'a candidate', '{}'::jsonb, 'pending')`,
      [`${P}cand`, spaceId],
    );
    const { source, version, fragment } = await mkChain(spaceId, "retire");
    const cit = await mkCitation("retire", version, fragment);

    await retireProjectSpace(PROJ);

    expect(await count("vault_claims", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("note_claims", "claim_id = $1", [claim])).toBe(0);
    expect(await count("claim_evidence", "claim_id = $1", [claim])).toBe(0);
    expect(await count("vault_notes", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("memory_candidates", "space_id = $1", [spaceId])).toBe(0);

    // The source is SOFT-deleted: the row is still there, marked deleted.
    expect(await count("knowledge_sources", "id = $1 AND deleted_at IS NOT NULL", [source])).toBe(1);
    // The chat outlived the project, so its citation still pins the version and the
    // fragment.
    expect(await count("knowledge_source_versions", "id = $1", [version])).toBe(1);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(1);
    expect(await count("message_citations", "id = $1", [cit])).toBe(1);
    // The space row itself stays — purge finds it by owner_user_id.
    expect(await count("spaces", "id = $1", [spaceId])).toBe(1);
    expect(await retireEvents(spaceId)).toBe(1);
  });

  it("retire writes EXACTLY one event — on a repeat and on an empty space alike", async () => {
    // A non-empty space: this is how teardown is re-driven from the worker tick
    // after a partial failure, and there must be no second event.
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    await mkClaim(`${P}claim2`, spaceId);
    await retireProjectSpace(PROJ);
    expect(await retireEvents(spaceId)).toBe(1);
    await expect(retireProjectSpace(PROJ)).resolves.toBeUndefined();
    expect(await retireEvents(spaceId)).toBe(1);

    // An empty space (the user cleared it by hand): nothing to remove, but the trace
    // must exist anyway — otherwise "no event" reads as "teardown never ran", which
    // is the very answer an operator goes to the audit log for.
    const emptyProj = `${P}empty-proj`;
    const emptySpace = await getOrCreateSpace({ type: "project", refId: emptyProj, ownerUserId: OWNER });
    await retireProjectSpace(emptyProj);
    expect(await retireEvents(emptySpace)).toBe(1);
    await retireProjectSpace(emptyProj);
    expect(await retireEvents(emptySpace)).toBe(1);

    // And a space that does not exist at all is tolerated too.
    await expect(retireProjectSpace(`${P}never-existed`)).resolves.toBeUndefined();
  });

  it("retire serializes on the space row, so the event cannot double", async () => {
    // "No event yet" is a read-modify-write, and on an EMPTY space no other row in
    // the transaction serializes it, so the space row lock is the only thing holding
    // the condition. A concurrent call would prove nothing here: without the lock it
    // is green anyway, because the first transaction commits in time. So the lock is
    // observed directly — another transaction holds the row and retire cannot move.
    const lockProj = `${P}lock-proj`;
    const spaceId = await getOrCreateSpace({ type: "project", refId: lockProj, ownerUserId: OWNER });

    const holder = await pool.connect();
    let pending: Promise<void>;
    try {
      await holder.query("BEGIN");
      // FOR KEY SHARE specifically, not FOR UPDATE: it conflicts with retire's lock
      // but NOT with the FOR KEY SHARE that an INSERT into audit_events takes on the
      // parent row through the FK. With FOR UPDATE here the insert itself would
      // block, and the test would be green even without the lock — that is, it would
      // check nothing. That same asymmetry is the reason for the lock: two concurrent
      // retires without it take only FOR KEY SHARE, which do not conflict with each
      // other, and the event doubles.
      await holder.query("SELECT id FROM spaces WHERE id = $1 FOR KEY SHARE", [spaceId]);
      pending = retireProjectSpace(lockProj);
      const outcome = await Promise.race([
        pending.then(() => "done" as const),
        new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 500)),
      ]);
      expect(outcome).toBe("blocked");
      expect(await retireEvents(spaceId)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    // The lock is released — the same call goes through, with exactly one event.
    await pending;
    expect(await retireEvents(spaceId)).toBe(1);
  });

  it("all three functions read and write THROUGH the ex they were given", async () => {
    // State BEFORE the transaction: a project space with one claim, both committed.
    const spaceId = await getOrCreateSpace({ type: "project", refId: PROJ, ownerUserId: OWNER });
    const claim = `${P}claim-ex`;
    await mkClaim(claim, spaceId);
    const userRef = `${P}ex-user`;
    const topic = "Topic inside a transaction";

    const seen = { space: [] as string[], note: [] as string[] };
    const boom = new Error("rollback");
    const err = await db
      .transaction(async (tx) => {
        // The second call must SEE the first's uncommitted row: a SELECT going around
        // ex would not find it, the repeated INSERT would silently swallow 23505, and
        // the function would throw "vanished after insert". So this pins the read and
        // the write alike.
        seen.space.push(await getOrCreateSpace({ type: "user", refId: userRef }, tx));
        seen.space.push(await getOrCreateSpace({ type: "user", refId: userRef }, tx));
        seen.note.push(await getOrCreateTopicNote(spaceId, topic, tx));
        seen.note.push(await getOrCreateTopicNote(spaceId, topic, tx));
        await retireProjectSpace(PROJ, tx);
        throw boom;
      })
      .then(() => null, (e: unknown) => e);

    expect(err).toBe(boom);
    expect(new Set(seen.space).size).toBe(1);
    expect(new Set(seen.note).size).toBe(1);

    // No statement escaped to the module-level `db`: one that did would commit on its
    // own and survive the rollback. This is the only check that catches an ex → db
    // substitution, and without it Tasks 4/5/6 would quietly lose atomicity.
    expect(await count("spaces", "type = 'user' AND ref_id = $1", [userRef])).toBe(0);
    expect(await count("vault_notes", "space_id = $1", [spaceId])).toBe(0);
    expect(await count("audit_events", "space_id = $1", [spaceId])).toBe(0);
    // And the claim retire deleted inside the transaction is back where it was.
    expect(await count("vault_claims", "id = $1", [claim])).toBe(1);
  });

  it("purge removes the user's spaces AND those of a long-retired project", async () => {
    const victim = `${P}victim`;
    await mkUser(victim);
    const userSpace = await getOrCreateSpace({ type: "user", refId: victim });
    const goneProject = `${P}gone-proj`;
    const projSpace = await getOrCreateSpace({ type: "project", refId: goneProject, ownerUserId: victim });
    // The project was deleted long ago: no projects row remains, the space stayed
    // retired.
    await retireProjectSpace(goneProject);
    const chainU = await mkChain(userSpace, "purgeu");
    const chainP = await mkChain(projSpace, "purgep");
    await mkClaim(`${P}claim3`, userSpace);

    // Exactly what the admin DELETE handler does: the users cascade takes chats →
    // messages → citations, and only then is nothing pinning the spaces.
    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, victim));
      await purgeUserSpaces(victim, tx);
    });

    expect(await count('"user"', "id = $1", [victim])).toBe(0);
    expect(await count("spaces", "owner_user_id = $1", [victim])).toBe(0);
    expect(await count("knowledge_sources", "id = ANY($1)", [[chainU.source, chainP.source]])).toBe(0);
    expect(await count("knowledge_fragments", "id = ANY($1)", [[chainU.fragment, chainP.fragment]])).toBe(0);
    expect(await count("vault_claims", "space_id = $1", [userSpace])).toBe(0);
  });

  it("a live citation rolls back the WHOLE purge transaction: the user stays", async () => {
    const victim = `${P}pinned-victim`;
    await mkUser(victim);
    const space = await getOrCreateSpace({ type: "user", refId: victim });
    const { source, version, fragment } = await mkChain(space, "pin");
    // The anomaly: the citation hangs in ANOTHER user's chat, so the victim's cascade
    // does not remove it and RESTRICT fires.
    await mkCitation("pin", version, fragment);

    const err = await db
      .transaction(async (tx) => {
        await tx.delete(users).where(eq(users.id, victim));
        await purgeUserSpaces(victim, tx);
      })
      .then(() => null, (e: unknown) => e);

    // drizzle >=0.36 wraps the driver error — code lives on e OR on e.cause.
    const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
    expect(code).toBe(FK_VIOLATION);

    // EVERYTHING rolled back, not just the space delete: otherwise an admin would see
    // an error with the user already destroyed.
    expect(await count('"user"', "id = $1", [victim])).toBe(1);
    expect(await count("spaces", "id = $1", [space])).toBe(1);
    expect(await count("knowledge_sources", "id = $1", [source])).toBe(1);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(1);
  });

  it("keys a topic by its key, not by the text shown to the user", async () => {
    const spaceId = await getOrCreateSpace({ type: "user", refId: OWNER });
    const first = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);

    // The rename that forked every topic in the live database: the DISPLAY changed and
    // the identity was the display. Simulated here by writing a different title onto the
    // note and asking for the same key again — which is what a rename control would do,
    // and what the en/uk switch would do if the title were localized.
    await q(`UPDATE vault_notes SET title = 'Something else entirely' WHERE id = $1`, [first]);
    const second = await getOrCreateTopicNote(spaceId, DEFAULT_TOPIC_KEY);

    expect(second).toBe(first);
    const notes = await q(
      `SELECT count(*)::int AS n FROM vault_notes WHERE space_id = $1 AND kind = 'memory_topic'`,
      [spaceId],
    );
    expect(notes.rows[0].n).toBe(1);
  });
});
