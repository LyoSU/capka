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

/** Two stable spaces for the node/edge/trust blocks below. The older tests mint their
 *  own space per `it` through `mkSpace`; these blocks assert about pairs of spaces
 *  (a cross-space edge, a cross-space conflict pointer), which needs both to exist at
 *  once and to be named. */
const SPACE_A = `${P}space-a`;
const SPACE_B = `${P}space-b`;

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
  "vault_nodes",
  "vault_edges",
];

/** Unique violation / foreign-key violation, per the SQLSTATE table. */
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
/** Check violation, per the SQLSTATE table. */
const CHECK_VIOLATION = "23514";

const q = (text: string, params: unknown[] = []) => pool.query(text, params);

const mkSpace = (id: string) =>
  q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'user', $1, $2)`, [id, USER]);

/** The node half of a subtype row. Raw fixtures write the subtype row directly, so they
 *  own the node row too — the composite FK is what turned "every subtype row has a node"
 *  from a convention into a constraint. */
const seedNode = (id: string, spaceId: string, kind: "claim" | "note" | "source") =>
  q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, spaceId, kind]);

const mkClaim = async (id: string, spaceId: string, extra: { slotKey?: string; supersedes?: string } = {}) => {
  await seedNode(id, spaceId, "claim");
  await q(
    `INSERT INTO vault_claims (id, space_id, statement, slot_key, origin, supersedes)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
    [id, spaceId, `statement ${id}`, extra.slotKey ?? null, extra.supersedes ?? null],
  );
};

/** A full source→version→fragment chain hanging off one space. */
const mkChain = async (spaceId: string) => {
  const source = `${spaceId}-src`;
  const version = `${spaceId}-ver`;
  const fragment = `${spaceId}-frag`;
  await seedNode(source, spaceId, "source");
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
    await mkSpace(SPACE_A);
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1, 'project', $1, $2)`, [
      SPACE_B,
      USER,
    ]);
  });

  it("all 13 vault tables exist", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [VAULT_TABLES],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...VAULT_TABLES].sort());
  });

  it("two active heads MAY share a slot: the key is a hint, not an identity", async () => {
    // The reversal of `uniq_vclaims_active_slot`, asserted rather than described.
    //
    // That index enforced a premise the maintainer's own data disproved: the slot key is
    // generated by the model, and the same model produced divergent keys for one subject
    // across turns (`user/pet` one turn, `user/pets/cat` the next; `user/work/role` vs
    // `profile/occupation`). So it constrained BYTES while the question a slot stands for
    // — "is this the same thing?" — is about meaning, and it turned the model's phrasing
    // drift into a failed insert on a path a person is waiting on.
    //
    // What replaces it is an honest limitation rather than a cleverer index: facts do not
    // merge yet, duplicates accumulate, and a person resolves them on the memory page.
    // A duplicate is repairable in one click; a wrong supersede is silent data loss.
    const space = `${P}slot`;
    await mkSpace(space);
    await mkClaim(`${space}-a`, space, { slotKey: "employer" });
    await mkClaim(`${space}-b`, space, { slotKey: "employer" });
    await mkClaim(`${space}-c`, space);
    expect(
      await count("vault_claims", "space_id = $1 AND slot_key = 'employer' AND superseded_at IS NULL", [space]),
    ).toBe(2);
    expect(await count("vault_claims", "space_id = $1", [space])).toBe(3);
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
    const note = async (id: string, kind: string, topicKey: string | null, title = "Work") => {
      await seedNode(id, space, "note");
      await q(`INSERT INTO vault_notes (id, space_id, title, kind, topic_key) VALUES ($1, $2, $3, $4, $5)`, [
        id,
        space,
        title,
        kind,
        topicKey,
      ]);
    };

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

  run("vault_nodes and vault_edges: the shapes that make a bad edge unrepresentable", () => {
    it("refuses an edge whose endpoints live in different spaces", async () => {
      // The whole point of UNIQUE (space_id, id): the FK carries the space, so the
      // pair (space_id, to_node_id) simply does not exist in the parent.
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n-a`, SPACE_A]);
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n-b`, SPACE_B]);
      await expect(
        q(
          `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
           VALUES ($1,$2,$3,$4,'references','{"kind":"system"}'::jsonb)`,
          [`${P}e-x`, SPACE_A, `${P}n-a`, `${P}n-b`],
        ),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
    });

    it("refuses a node kind outside the three", async () => {
      await expect(
        q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'person')`, [`${P}n-k`, SPACE_A]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "ck_vault_nodes_kind" });
    });

    it("refuses a self-edge", async () => {
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'note')`, [`${P}n-s`, SPACE_A]);
      await expect(
        q(
          `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
           VALUES ($1,$2,$3,$3,'contains','{"kind":"system"}'::jsonb)`,
          [`${P}e-s`, SPACE_A, `${P}n-s`],
        ),
        // 23514 is check_violation. Assert on the SQLSTATE and on the constraint NAME, not
        // on the message: `error.message` is the primary line only, and this file's other
        // negative tests already read `code` for exactly that reason.
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "ck_vault_edges_not_self" });
    });

    it("refuses a relation outside the three", async () => {
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'note')`, [`${P}n-r1`, SPACE_A]);
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n-r2`, SPACE_A]);
      await expect(
        q(
          `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
           VALUES ($1,$2,$3,$4,'works_for','{"kind":"system"}'::jsonb)`,
          [`${P}e-r`, SPACE_A, `${P}n-r1`, `${P}n-r2`],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "ck_vault_edges_relation" });
    });

    it("allows one live edge per (from, to, relation) and a re-link after a soft delete", async () => {
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'note')`, [`${P}n-u1`, SPACE_A]);
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n-u2`, SPACE_A]);
      const edge = (id: string) =>
        q(
          `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
           VALUES ($1,$2,$3,$4,'contains','{"kind":"system"}'::jsonb)`,
          [id, SPACE_A, `${P}n-u1`, `${P}n-u2`],
        );
      await edge(`${P}e-u1`);
      await expect(edge(`${P}e-u2`)).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "uniq_live_vault_edge",
      });
      // Soft-deleting the first frees the slot — a re-link must not fork into two live edges.
      await q(`UPDATE vault_edges SET deleted_at = now() WHERE id = $1`, [`${P}e-u1`]);
      await edge(`${P}e-u3`);
      const live = await q(
        `SELECT count(*)::int AS n FROM vault_edges WHERE space_id = $1 AND deleted_at IS NULL`,
        [SPACE_A],
      );
      expect(live.rows[0].n).toBe(1);
    });

    it("cascades edges when a node row is hard-deleted", async () => {
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'note')`, [`${P}n-c1`, SPACE_A]);
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n-c2`, SPACE_A]);
      await q(
        `INSERT INTO vault_edges (id, space_id, from_node_id, to_node_id, relation, created_by)
         VALUES ($1,$2,$3,$4,'contains','{"kind":"system"}'::jsonb)`,
        [`${P}e-c`, SPACE_A, `${P}n-c1`, `${P}n-c2`],
      );
      await q(`DELETE FROM vault_nodes WHERE id = $1`, [`${P}n-c1`]);
      const left = await q(`SELECT count(*)::int AS n FROM vault_edges WHERE id = $1`, [`${P}e-c`]);
      expect(left.rows[0].n).toBe(0);
    });
  });
});
