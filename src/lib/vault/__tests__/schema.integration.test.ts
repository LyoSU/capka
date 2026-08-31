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
  "vault_search_documents",
];

/** Unique violation / foreign-key violation, per the SQLSTATE table. */
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
/** Check violation, per the SQLSTATE table. */
const CHECK_VIOLATION = "23514";
/** "Cannot insert a non-DEFAULT value into a generated column" — ERRCODE_GENERATED_ALWAYS.
 *  NOT 42601 (that is syntax_error), and NOT matchable on the message: Postgres puts the
 *  primary line at `error.message` ("cannot insert a non-DEFAULT value into column ...")
 *  and the words "generated column" in `error.detail`, which `toThrow(regex)` never reads. */
const GENERATED_ALWAYS = "428C9";
/** not_null_violation. `node-postgres` surfaces the offending column at `error.column`. */
const NOT_NULL_VIOLATION = "23502";

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
    `INSERT INTO vault_claims (id, space_id, statement, slot_key, origin, supersedes, source_class)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, 'agent_inferred')`,
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

  it("all 14 vault tables exist", async () => {
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

  run("vault_claims trust columns: the shapes no writer can talk its way past", () => {
    it("source_class is NOT NULL with NO default", async () => {
      // Both halves, from information_schema, because they fail differently: a default
      // would let an unlisted writer inherit the strongest class by omission, and
      // nullability would let it store nothing at all.
      const r = await q(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'vault_claims' AND column_name = 'source_class'`,
      );
      expect(r.rows[0]).toMatchObject({ is_nullable: "NO", column_default: null });
    });

    it("refuses an insert that states no class", async () => {
      await seedNode(`${P}tc-1`, SPACE_A, "claim");
      await expect(
        q(`INSERT INTO vault_claims (id, space_id, statement, origin) VALUES ($1,$2,'no class','{}'::jsonb)`, [
          `${P}tc-1`,
          SPACE_A,
        ]),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION, column: "source_class" });
    });

    it("refuses a class outside the five", async () => {
      await seedNode(`${P}tc-2`, SPACE_A, "claim");
      await expect(
        q(
          `INSERT INTO vault_claims (id, space_id, statement, origin, source_class)
           VALUES ($1,$2,'bad class','{}'::jsonb,'trusted')`,
          [`${P}tc-2`, SPACE_A],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "ck_vault_claims_source_class" });
    });

    it("computes prompt_access from source_class and sensitive, and refuses to be written", async () => {
      const cases: [string, boolean, string][] = [
        ["legacy_confirmed", false, "manifest"],
        ["owner_authored", false, "manifest"],
        ["user_direct", false, "manifest"],
        ["agent_inferred", false, "memory_search"],
        ["untrusted_derived", false, "knowledge_search"],
        ["user_direct", true, "owner_only"],
        ["untrusted_derived", true, "owner_only"],
      ];
      for (const [cls, sensitive, expected] of cases) {
        const id = `${P}pa-${cls}-${sensitive}`;
        await seedNode(id, SPACE_A, "claim");
        await q(
          `INSERT INTO vault_claims (id, space_id, statement, origin, source_class, sensitive)
           VALUES ($1,$2,'x','{}'::jsonb,$3,$4)`,
          [id, SPACE_A, cls, sensitive],
        );
        const r = await q(`SELECT prompt_access FROM vault_claims WHERE id = $1`, [id]);
        expect(r.rows[0].prompt_access).toBe(expected);
      }
      // There is no write path to generate around - not for a service, not for a migration,
      // not for raw SQL. 428C9 is ERRCODE_GENERATED_ALWAYS.
      await seedNode(`${P}pa-write`, SPACE_A, "claim");
      await expect(
        q(
          `INSERT INTO vault_claims (id, space_id, statement, origin, source_class, prompt_access)
           VALUES ($1,$2,'x','{}'::jsonb,'agent_inferred','manifest')`,
          [`${P}pa-write`, SPACE_A],
        ),
      ).rejects.toMatchObject({ code: GENERATED_ALWAYS });
    });

    it("recomputes prompt_access when the owner raises sensitivity", async () => {
      // The reason it is STORED-generated rather than denormalized by a writer: an owner's
      // sensitivity change reaches the channel with no path remembering to re-project.
      const id = `${P}pa-raise`;
      await seedNode(id, SPACE_A, "claim");
      await q(
        `INSERT INTO vault_claims (id, space_id, statement, origin, source_class)
         VALUES ($1,$2,'x','{}'::jsonb,'owner_authored')`,
        [id, SPACE_A],
      );
      await q(`UPDATE vault_claims SET sensitive = true WHERE id = $1`, [id]);
      const r = await q(`SELECT prompt_access FROM vault_claims WHERE id = $1`, [id]);
      expect(r.rows[0].prompt_access).toBe("owner_only");
    });

    it("refuses a cross-space conflicts_with pointer", async () => {
      // The composite FK makes a cross-space or dangling conflict unrepresentable
      // rather than something readConflicts has to notice.
      await seedNode(`${P}cw-a`, SPACE_A, "claim");
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}cw-b`, SPACE_B]);
      await expect(
        q(
          `INSERT INTO vault_claims (id, space_id, statement, origin, source_class, conflicts_with)
           VALUES ($1,$2,'x','{}'::jsonb,'agent_inferred',$3)`,
          [`${P}cw-a`, SPACE_A, `${P}cw-b`],
        ),
      ).rejects.toMatchObject({ code: FK_VIOLATION, constraint: "vault_claims_conflicts_with_fk" });
    });

    it("mapped every pre-existing head by review_status, and promoted no unverified one", async () => {
      // Asserted against the real table rather than a fixture: quarantine's successor is a
      // WEAKER channel, not a promotion, and this is the only place that can go wrong
      // exactly once. It writes nothing, so it is left un-prefixed on purpose.
      //
      // WHAT IT PROVES: that migration 0061's backfill mapped the rows that already existed
      // when it ran. WHAT IT DELIBERATELY DOES NOT: say anything about rows written since.
      // The distinction is not pedantry — the mapping is a MIGRATION rule, not an invariant
      // of the table, and `createClaim` is designed to break it (it can only produce
      // `review_status = 'unverified'`, while its callers legitimately pass
      // `ownerAuthored()`). An unscoped version of this control therefore goes
      // red whenever another suite's fixtures happen to be live during this query, which
      // `vitest.config.ts` permits — `fileParallelism` is only disabled in
      // `vitest.integration.db.config.ts`, and the command both briefs prescribe uses the
      // base config. A control that reddens for reasons unrelated to what it measures is
      // the thing that teaches people to re-run instead of read.
      //
      // TWO clauses bound it, because `recorded_at` alone is not enough: fixtures do not
      // only write "now". `claims.integration.test.ts` back-dates claims to January to test
      // the ordering keys, which lands `owner_authored` + `unverified` rows INSIDE any
      // date window and reddened this control on 4 of 6 parallel runs. `normalized_hash`
      // is the clause that actually separates the two populations: every post-0061 writer
      // fills it (`createClaim` and `updateClaim` both hash unconditionally), and the rows
      // the migration touched carry none — 0 of 52 on the live database, because the column
      // is written forward only and deliberately never backfilled.
      //
      // The boundary is read from drizzle's own bookkeeping rather than hardcoded as a date,
      // so this also ASSERTS its precondition instead of inferring it: if 0061 is not
      // applied, there is no row and the test fails loudly rather than passing vacuously.
      const [{ boundary }] = (
        await q(
          `SELECT to_timestamp(created_at / 1000.0)::timestamp AS boundary
             FROM drizzle.__drizzle_migrations WHERE created_at = 1788130121997`,
        )
      ).rows as { boundary: Date }[];
      expect(boundary).toBeInstanceOf(Date);

      const bad = await q(
        `SELECT count(*)::int AS n FROM vault_claims
         WHERE recorded_at < $1 AND normalized_hash IS NULL
           AND ((review_status = 'unverified' AND source_class <> 'agent_inferred')
             OR (review_status = 'confirmed'  AND source_class <> 'legacy_confirmed'))`,
        [boundary],
      );
      expect(bad.rows[0].n).toBe(0);
      const promoted = await q(
        `SELECT count(*)::int AS n FROM vault_claims
         WHERE recorded_at < $1 AND normalized_hash IS NULL
           AND review_status = 'unverified' AND prompt_access = 'manifest'`,
        [boundary],
      );
      expect(promoted.rows[0].n).toBe(0);
      // On a database that had claims before 0061 this covers all of them; on a fresh one
      // there are none and both counts are vacuously 0, which is the correct answer there.
      // Recorded so nobody later reads a green run as proof that rows were checked.
      //
      // The one population it cannot tell apart from a migrated row is a RAW-SQL fixture
      // that both back-dates `recorded_at` and states a mismatched review_status/class pair,
      // since raw inserts bypass the writers and so carry no hash either. Every raw claim
      // fixture in this suite states a matching pair today (`model-view`'s 2020-dated rows
      // are `confirmed` + `legacy_confirmed`), so none is in scope — but a future one that
      // disagrees with itself would redden this control rather than its own test.
    });
  });

  it("vault_notes carries the three retention columns, on the identity not the version", async () => {
    // Retention is a property of THE NOTE, not of a revision: a new revision must not
    // silently reset or inherit a horizon, and `last_used_at` on a version would fragment
    // "when was this note last read" across its history.
    //
    // Nullability and default are asserted, not only the names: all three are horizons that
    // mean "not set yet", so a `NOT NULL DEFAULT now()` variant would carry the same three
    // names, pass a name-only check, and give every note that has never been read a
    // `last_used_at` and every note an expiry it never earned.
    const cols = await q(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'vault_notes' AND column_name IN ('expires_at','retired_at','last_used_at')
       ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "expires_at", is_nullable: "YES", column_default: null },
      { column_name: "last_used_at", is_nullable: "YES", column_default: null },
      { column_name: "retired_at", is_nullable: "YES", column_default: null },
    ]);
  });
});
