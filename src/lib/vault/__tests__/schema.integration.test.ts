import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run src/lib/vault
 *
 * The vault's invariants are declared in `schema.ts` but ENFORCED by Postgres —
 * partial unique indexes and the cascade/restrict chain. Nothing here mocks: a
 * unique index that Drizzle emitted without its `WHERE`, or an FK generated as
 * `no action` instead of `restrict`, is invisible to a typecheck and to any
 * in-memory double, and shows up only as a real 23505/23503 (or its absence).
 */
import { pool } from "@/lib/db";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

/** Every fixture id carries this prefix, so cleanup is a single LIKE per table. */
const P = "vaulttest-";
const USER = `${P}user`;
const CHAT = `${P}chat`;
const MSG = `${P}msg`;

const VAULT_TABLES = [
  "spaces",
  "knowledge_sources",
  "knowledge_source_versions",
  "knowledge_fragments",
  "vault_notes",
  "note_claims",
  "vault_claims",
  "claim_evidence",
  "memory_candidates",
  "message_citations",
  "audit_events",
];

/** Unique violation / foreign-key violation, per the SQLSTATE table. */
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const mkSpace = (id: string) =>
  q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $1, $2)`, [id, USER]);

const mkClaim = (id: string, spaceId: string, extra: { slotKey?: string; supersedes?: string } = {}) =>
  q(
    `INSERT INTO vault_claims (id, space_id, statement, slot_key, origin, supersedes)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [id, spaceId, `statement ${id}`, extra.slotKey ?? null, extra.supersedes ?? null],
  );

/** A full source→version→fragment chain hanging off one space. */
const mkChain = async (spaceId: string) => {
  const source = `${spaceId}-src`;
  const version = `${spaceId}-ver`;
  const fragment = `${spaceId}-frag`;
  await q(
    `INSERT INTO knowledge_sources (id, space_id, title, origin, created_by)
     VALUES ($1, $2, 'fixture', '{"type":"upload"}'::jsonb, $3)`,
    [source, spaceId, USER],
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

const count = async (table: string, where: string, params: unknown[]) => {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params);
  return Number(rows[0].n);
};

const cleanup = async () => {
  // Citations RESTRICT the cascade, so they go first — the same order the product
  // has to use, which is why this helper is also a small proof the chain is sane.
  await q(`DELETE FROM message_citations WHERE id LIKE $1`, [`${P}%`]);
  await q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
};

run("vault schema", () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, 'vault test', 'vault@test.local', true, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await q(`INSERT INTO chats (id, user_id, title) VALUES ($1, $2, 'vault test') ON CONFLICT (id) DO NOTHING`, [
      CHAT,
      USER,
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM chats WHERE id = $1`, [CHAT]); // messages cascade
    await q(`DELETE FROM "user" WHERE id = $1`, [USER]);
  });

  beforeEach(async () => {
    await cleanup();
    // The message is re-created per test, not once: the cascade test DELETES it to
    // prove a citation dies with its message, and restoring it in the body would
    // leave the fixture missing for the rest of the file the moment that test fails.
    await q(
      `INSERT INTO messages (id, chat_id, role, content) VALUES ($1, $2, 'assistant', 'hi')
         ON CONFLICT (id) DO NOTHING`,
      [MSG, CHAT],
    );
  });

  it("all 11 vault tables exist", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [VAULT_TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...VAULT_TABLES].sort());
  });

  it("two active heads for one slot are impossible (unique violation)", async () => {
    const space = `${P}slot`;
    await mkSpace(space);
    await mkClaim(`${space}-a`, space, { slotKey: "employer" });
    await expect(mkClaim(`${space}-b`, space, { slotKey: "employer" })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });

    // The index is PARTIAL on both halves, and each half is load-bearing:
    // superseding the head frees the slot, and a null slot_key never collides.
    await q(`UPDATE vault_claims SET superseded_at = now() WHERE id = $1`, [`${space}-a`]);
    await mkClaim(`${space}-b`, space, { slotKey: "employer" });
    await mkClaim(`${space}-c`, space);
    await mkClaim(`${space}-d`, space);
    expect(await count("vault_claims", "space_id = $1", [space])).toBe(4);
  });

  it("two successors of one claim are impossible", async () => {
    const space = `${P}succ`;
    await mkSpace(space);
    await mkClaim(`${space}-base`, space);
    await mkClaim(`${space}-next`, space, { supersedes: `${space}-base` });
    await expect(mkClaim(`${space}-race`, space, { supersedes: `${space}-base` })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    // `supersedes IS NULL` is the common case and must not be constrained at all.
    expect(await count("vault_claims", "space_id = $1 AND supersedes IS NULL", [space])).toBe(1);
  });

  it("the space cascade removes sources→versions→fragments when nothing cites them", async () => {
    const space = `${P}cascade`;
    await mkSpace(space);
    const { source, version, fragment } = await mkChain(space);

    await q(`DELETE FROM spaces WHERE id = $1`, [space]);

    expect(await count("knowledge_sources", "id = $1", [source])).toBe(0);
    expect(await count("knowledge_source_versions", "id = $1", [version])).toBe(0);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(0);
  });

  it("the space cascade is BLOCKED (FK restrict) while a version is cited", async () => {
    const space = `${P}pinned`;
    await mkSpace(space);
    const { source, version, fragment } = await mkChain(space);
    await q(
      `INSERT INTO message_citations
         (id, message_id, ordinal, source_version_id, fragment_id, quote_snapshot, locator_snapshot, title_snapshot)
       VALUES ($1, $2, 1, $3, $4, 'quoted text', '{"scheme":"char"}'::jsonb, 'fixture')`,
      [`${P}cit`, MSG, version, fragment],
    );

    await expect(q(`DELETE FROM spaces WHERE id = $1`, [space])).rejects.toMatchObject({ code: FK_VIOLATION });

    // RESTRICT aborts the whole statement, so the delete is all-or-nothing: the
    // space and every row under it survive, not just the pinned version.
    expect(await count("spaces", "id = $1", [space])).toBe(1);
    expect(await count("knowledge_sources", "id = $1", [source])).toBe(1);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(1);

    // The citation is the ONLY pin, and killing the message removes it: the very
    // same delete then goes through untouched.
    await q(`DELETE FROM messages WHERE id = $1`, [MSG]);
    expect(await count("message_citations", "id = $1", [`${P}cit`])).toBe(0);
    await q(`DELETE FROM spaces WHERE id = $1`, [space]);
    expect(await count("knowledge_fragments", "id = $1", [fragment])).toBe(0);
  });

  it("two topics with one KEY in a space are impossible; one title twice is not", async () => {
    const space = `${P}notes`;
    await mkSpace(space);
    const note = (id: string, kind: string, topicKey: string | null, title = "Work") =>
      q(`INSERT INTO vault_notes (id, space_id, title, kind, topic_key) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        space,
        title,
        kind,
        topicKey,
      ]);

    await note(`${space}-t1`, "memory_topic", "work");
    await expect(note(`${space}-t2`, "memory_topic", "work")).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // The point of moving the index off the title: two topics may legitimately end up
    // SHOWING the same words (a user-named one colliding with a built-in label). What
    // they may not share is the key. Under the old index this insert was the violation.
    await note(`${space}-t3`, "memory_topic", "suppliers");
    await note(`${space}-n1`, "note", null);
    await note(`${space}-n2`, "note", null);
    expect(await count("vault_notes", "space_id = $1", [space])).toBe(4);
  });

  it("two fragments sharing a (version, ordinal) are impossible", async () => {
    const space = `${P}frag`;
    await mkSpace(space);
    const { version } = await mkChain(space); // already holds ordinal 0

    const frag = (id: string, ordinal: number) =>
      q(
        `INSERT INTO knowledge_fragments (id, version_id, ordinal, text, locator)
         VALUES ($1, $2, $3, 'text', '{}'::jsonb)`,
        [id, version, ordinal],
      );

    await expect(frag(`${space}-dup`, 0)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await frag(`${space}-next`, 1);
    expect(await count("knowledge_fragments", "version_id = $1", [version])).toBe(2);
  });
});
