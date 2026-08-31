import { describe, it, expect, afterAll } from "vitest";

/** Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... node_modules/.bin/vitest run <this file> */
import { pool } from "@/lib/db";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);

run("vault_note_versions", () => {
  afterAll(async () => { await q(`DELETE FROM spaces WHERE id LIKE 'nvtest-%'`); });

  it("gives every pre-existing note a revision 1 whose columns are the note's own", async () => {
    // The LIVE data, read not inferred: the backfill has already run at boot, so this
    // asserts against the maintainer's real notes rather than a fixture.
    const { rows } = await q(`
      SELECT n.id, n.current_revision, n.current_version_id, v.revision, v.title, v.body_markdown, v.source_class
        FROM vault_notes n JOIN vault_note_versions v ON v.id = n.current_version_id`);
    const notes = (await q(`SELECT count(*)::int AS n FROM vault_notes`)).rows[0].n as number;
    expect(rows.length).toBe(notes);
    for (const r of rows) {
      expect(r.current_revision).toBe(1);
      expect(r.revision).toBe(1);
      expect(r.source_class).toBe("owner_authored");
    }
  });

  it("leaves current_version_id NULLABLE, and the migration is what proved the backfill", async () => {
    // Ruling 4, asserted rather than assumed, because the earlier draft of this plan
    // asserted the opposite and broke five of its own writers with it. Postgres evaluates
    // NOT NULL before index insertion, and `vault_note_versions.note_id` forces the NOTE
    // row to exist before any version does — so every legal writer must pass through a
    // moment where this column is NULL. A constraint that the steady state cannot satisfy
    // is not a stricter schema, it is a broken one.
    //
    // What the NOT NULL was standing in for — "a backfill that created no version rows
    // fails loudly rather than emptying the manifest's Topics: block" — is asserted in the
    // migration by a RAISE EXCEPTION, which fails at exactly the moment the guarantee is
    // about and never again.
    const { rows } = await q(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'vault_notes' AND column_name = 'current_version_id'`);
    expect(rows[0].is_nullable).toBe("YES");
    // And the thing that actually matters is true of the live data:
    const orphans = await q(`SELECT count(*)::int AS n FROM vault_notes WHERE current_version_id IS NULL`);
    expect(orphans.rows[0].n).toBe(0);
  });

  it("refuses two versions at one revision", async () => {
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ('nvtest-s','user','nvtest-u','nvtest-u')`);
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ('nvtest-n','nvtest-s','note')`);
    await q(`INSERT INTO vault_notes (id, space_id, title, kind, current_revision)
             VALUES ('nvtest-n','nvtest-s','t','note',1)`);
    const ins = (id: string) => q(
      `INSERT INTO vault_note_versions (id, note_id, revision, title, body_markdown, source_class, provenance)
       VALUES ($1,'nvtest-n',1,'t','b','owner_authored','{}'::jsonb)`, [id]);
    await ins("nvtest-v1");
    await expect(ins("nvtest-v2")).rejects.toMatchObject({
      code: "23505", constraint: "uniq_vnote_versions_rev",
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
