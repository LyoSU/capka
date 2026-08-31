import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/** Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... node_modules/.bin/vitest run <this file> */
import { pool } from "@/lib/db";
import { resolveTopic } from "../topics";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

/** Every fixture id carries this prefix, and every fixture row lives in `SPACE` — which is
 *  what lets the assertions below be SCOPED. Six other suites raw-insert notes, and this
 *  file runs beside them: a `count(*) FROM vault_notes` is a reading about their fixtures
 *  as much as about ours, and it has failed for exactly that reason. */
const SPACE = "nvtest-s";

/** The shipped migration, read rather than restated — see the replay test. */
const MIGRATION = readFileSync(new URL("../../../../drizzle/0065_note_versions_backfill.sql", import.meta.url), "utf8");
const stmt = (needle: string) => {
  const found = MIGRATION.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes(needle));
  if (!found) throw new Error(`migration 0065 no longer contains a statement matching ${needle}`);
  return found;
};
/** The shipped statement, narrowed by ONE appended predicate to this suite's own space.
 *  Not cosmetic: both data statements are whole-table by design, and replaying one verbatim
 *  here made a version for every note six parallel suites happened to have half-written —
 *  which raised a 23503 the moment one of them deleted its fixture. The narrowing changes
 *  nothing the test is about: the SELECT list, the `coalesce`, the class and the provenance
 *  are still whatever `0065` says today, so a mutation of any of them still reddens. */
const scoped = (needle: string) => `${stmt(needle).replace(/;\s*$/, "")} AND n.space_id = $1`;

/** The note+version pair a REAL writer produces, so nothing here is vacuous on a database
 *  where the backfill had nothing to carry — which is every CI database. */
let seeded: { id: string; title: string };

run("vault_note_versions", () => {
  beforeAll(async () => {
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user','nvtest-u','nvtest-u')`, [SPACE]);
    seeded = await resolveTopic(SPACE, "Fixture Topic");
  });
  afterAll(async () => { await q(`DELETE FROM spaces WHERE id LIKE 'nvtest-%'`); });

  it("gives every note a revision 1 whose title and body are the note's own", async () => {
    // Two populations, one rule: the rows the boot backfill carried (the maintainer's own
    // notes, on a database that had any) and the rows the production writer minted (this
    // suite's fixture, on every database). Scoped to those two rather than to the whole
    // table, because a parallel suite's version-less note is not this test's business.
    const { rows } = await q(`
      SELECT n.id, n.title AS note_title, coalesce(n.body, '') AS note_body, n.current_revision,
             v.revision, v.title AS ver_title, v.body_markdown, v.source_class
        FROM vault_notes n JOIN vault_note_versions v ON v.id = n.current_version_id
       WHERE v.provenance->>'kind' = 'backfill_revision_1' OR n.space_id = $1`, [SPACE]);
    // NOT VACUOUS. The first draft of this test compared a join count to a table count, so
    // on a database with no notes it asserted 0 === 0 and its loop never ran — the backfill's
    // only witness was one laptop's five rows, and CI asserted nothing at all.
    expect(rows.map((r: { id: string }) => r.id)).toContain(seeded.id);
    for (const r of rows) {
      expect(r.current_revision).toBe(1);
      expect(r.revision).toBe(1);
      expect(r.source_class).toBe("owner_authored");
      // THE COPY ITSELF, which nothing used to assert: the backfill selects `n.title` and
      // `coalesce(n.body,'')`, and either replaced by a literal left the suite green.
      expect(r.ver_title).toBe(r.note_title);
      expect(r.body_markdown).toBe(r.note_body);
    }
  });

  it("replays the shipped backfill over a version-less note, and its guard fires on one", async () => {
    // The durable form of the one-shot scratch-database proof: the statements are PARSED
    // OUT of `0065`, never restated, so a copy cannot go on passing after the shipped one
    // changes. Everything happens inside a transaction that is rolled back, so this writes
    // nothing — and it is what makes the title/body copy above reddenable on a fresh
    // database, where the backfill itself carried no rows.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ('nvtest-bf',$1,'note')`, [SPACE]);
      await client.query(
        `INSERT INTO vault_notes (id, space_id, title, body, kind) VALUES ('nvtest-bf',$1,'Carried title','carried body','note')`,
        [SPACE],
      );
      // The completeness guard, on a note that has no revision 1 yet. Race-free in the only
      // direction that matters: a parallel suite's orphan can only make it fire, and this
      // transaction guarantees at least one.
      await client.query("SAVEPOINT guard");
      await expect(client.query(stmt("RAISE EXCEPTION"))).rejects.toMatchObject({ code: "P0001" });
      await client.query("ROLLBACK TO SAVEPOINT guard");

      await client.query(scoped("INSERT INTO vault_note_versions"), [SPACE]);
      await client.query(scoped("UPDATE vault_notes"), [SPACE]);
      const { rows } = await client.query(`
        SELECT v.title, v.body_markdown, v.revision, v.source_class, v.provenance->>'kind' AS kind,
               n.current_revision, n.current_version_id = v.id AS pointed
          FROM vault_notes n JOIN vault_note_versions v ON v.note_id = n.id WHERE n.id = 'nvtest-bf'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: "Carried title",
        body_markdown: "carried body",
        revision: 1,
        source_class: "owner_authored",
        kind: "backfill_revision_1",
        current_revision: 1,
        pointed: true,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("leaves current_version_id NULLABLE, and points it at a real version", async () => {
    // Ruling 4, asserted rather than assumed, because the earlier draft of this plan
    // asserted the opposite and broke five of its own writers with it. Postgres evaluates
    // NOT NULL before index insertion, and `vault_note_versions.note_id` forces the NOTE
    // row to exist before any version does — so every legal writer must pass through a
    // moment where this column is NULL. A constraint that the steady state cannot satisfy
    // is not a stricter schema, it is a broken one.
    //
    // What the NOT NULL was standing in for — "a backfill that created no version rows
    // fails loudly rather than emptying the manifest's Topics: block" — is asserted in the
    // migration by a RAISE EXCEPTION, witnessed by the replay above.
    const { rows } = await q(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'vault_notes' AND column_name = 'current_version_id'`);
    expect(rows[0].is_nullable).toBe("YES");
    // Nullable is not unconstrained: the pointer is an FK, so it is null or it is a version.
    // (This used to count orphans across the WHOLE table, which reads a parallel suite's
    // half-written fixture as this feature's defect — and did, 1 run in 3.)
    const orphans = await q(`SELECT count(*)::int AS n FROM vault_notes WHERE space_id = $1 AND current_version_id IS NULL`, [SPACE]);
    expect(orphans.rows[0].n).toBe(0);
    await expect(q(`UPDATE vault_notes SET current_version_id = 'no-such-version' WHERE id = $1`, [seeded.id]))
      .rejects.toMatchObject({
        code: "23503", constraint: "vault_notes_current_version_id_vault_note_versions_id_fk",
      });
  });

  it("refuses two versions at one revision", async () => {
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ('nvtest-n',$1,'note')`, [SPACE]);
    await q(`INSERT INTO vault_notes (id, space_id, title, kind, current_revision)
             VALUES ('nvtest-n',$1,'t','note',1)`, [SPACE]);
    const ins = (id: string) => q(
      `INSERT INTO vault_note_versions (id, note_id, revision, title, body_markdown, source_class, provenance)
       VALUES ($1,'nvtest-n',1,'t','b','owner_authored','{}'::jsonb)`, [id]);
    await ins("nvtest-v1");
    await expect(ins("nvtest-v2")).rejects.toMatchObject({
      code: "23505", constraint: "uniq_vnote_versions_rev",
    });
  });

  it("refuses a source_class outside the five", async () => {
    // The TS enum is compile-time only, so this CHECK is the whole of what stands between a
    // raw-SQL writer — a migration, a fixture, a psql session — and a class the generated
    // `prompt_access` expression has no arm for.
    await expect(q(
      `INSERT INTO vault_note_versions (id, note_id, revision, title, body_markdown, source_class, provenance)
       VALUES ('nvtest-v3','nvtest-n',3,'t','b','trusted_somehow','{}'::jsonb)`,
    )).rejects.toMatchObject({
      code: "23514", constraint: "ck_vnote_versions_source_class",
    });
  });

  it("generates prompt_access from source_class and sensitive, with no write path", async () => {
    await q(`UPDATE vault_note_versions SET source_class='untrusted_derived' WHERE id='nvtest-v1'`);
    expect((await q(`SELECT prompt_access FROM vault_note_versions WHERE id='nvtest-v1'`)).rows[0].prompt_access)
      .toBe("knowledge_search");
    await expect(q(`UPDATE vault_note_versions SET prompt_access='manifest' WHERE id='nvtest-v1'`))
      .rejects.toMatchObject({ code: "428C9" });
  });

  it("cascades versions and their evidence from the note", async () => {
    await q(`INSERT INTO note_version_evidence (id, note_version_id, block_ordinal, relation)
             VALUES ('nvtest-e','nvtest-v1',0,'supports')`);
    await q(`DELETE FROM vault_notes WHERE id='nvtest-n'`);
    expect((await q(`SELECT count(*)::int AS n FROM vault_note_versions WHERE note_id='nvtest-n'`)).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM note_version_evidence WHERE id='nvtest-e'`)).rows[0].n).toBe(0);
  });
});
