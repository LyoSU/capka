import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * The search PROJECTION, asserted against a real Postgres because everything it is made of
 * - the extension, the generated tsvector, the trigram operator class - is a property of
 * the database and not of any TypeScript this repo can typecheck.
 *
 * The projection holds text and ids ONLY. There is deliberately no `prompt_access` column
 * here: the round-0 draft denormalized it and made this table a second entrance carrying
 * none of the lifecycle state the first one filters on. The mints join the authoritative
 * row instead, which Task 11 asserts.
 */
import { pool } from "@/lib/db";
import { norm } from "../text";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const P = "vsdoctest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

/** SQLSTATEs, per PostgreSQL Appendix A. 428C9 is ERRCODE_GENERATED_ALWAYS - the
 *  message line reads "cannot insert a non-DEFAULT value into column ..." and the words
 *  "generated column" live in DETAIL, so a message regex can never match it. */
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const GENERATED_ALWAYS = "428C9";

const insertDoc = (id: string, nodeId: string, kind: string, title: string, owner: string, model: string | null) =>
  q(
    `INSERT INTO vault_search_documents (id, space_id, node_id, kind, title, owner_text, model_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, SPACE_A, nodeId, kind, title, owner, model],
  );

run("vault_search_documents: the projection's own shape", () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1,'search doc test',$2,true,now(),now()) ON CONFLICT DO NOTHING`,
      [OWNER, `${OWNER}@test.local`],
    );
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await q(`DELETE FROM "user" WHERE id = $1`, [OWNER]);
  });
  beforeEach(async () => {
    await cleanup();
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'user',$2,$2)`, [SPACE_A, OWNER]);
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}n1`, SPACE_A]);
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'note')`, [`${P}n2`, SPACE_A]);
  });

  it("has pg_trgm installed as a hard requirement, not a probe", async () => {
    const r = await q(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(r.rows[0].n).toBe(1);
  });

  it("carries no prompt_access column", async () => {
    // H7, asserted rather than remembered: a channel column here would be a second
    // entrance holding no superseded_at, no retired_at, no expires_at, no deleted_at.
    const r = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'vault_search_documents'
         AND column_name IN ('prompt_access','source_class','superseded_at','retired_at','deleted_at')`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("generates the tsvectors and refuses to let a writer set them", async () => {
    await insertDoc(`${P}d1`, `${P}n1`, "claim", "", "reports go out on fridays", "reports go out on fridays");
    const hit = await q(
      `SELECT id FROM vault_search_documents
       WHERE model_tsv @@ websearch_to_tsquery('simple', $1) AND space_id = $2`,
      ["fridays", SPACE_A],
    );
    expect(hit.rows).toHaveLength(1);
    await expect(
      q(
        `INSERT INTO vault_search_documents (id, space_id, node_id, kind, owner_text, model_tsv)
         VALUES ($1,$2,$3,'claim','x', to_tsvector('simple','x'))`,
        [`${P}d-bad`, SPACE_A, `${P}n2`],
      ),
    ).rejects.toMatchObject({ code: GENERATED_ALWAYS });
  });

  it("generates norm_* columns that agree with text.ts::norm", async () => {
    // The JS normalizer runs on the QUERY side and the SQL one on the STORED side; they
    // are two expressions answering one question, so the agreement is asserted rather
    // than assumed. If this fails, do not "fix" norm - see its docstring; widen the SQL
    // character class instead.
    //
    // THE NON-ASCII SAMPLES ARE THE TEST. JS `\s` matches NBSP (U+00A0), the U+2000-U+200A
    // block, U+2007 and U+FEFF; Postgres's ARE `\s` means [[:space:]], which under a glibc
    // UTF-8 collation does NOT include NBSP. One pasted non-breaking space then normalizes
    // one way in the stored column and the other way in the query, and the trigram lane
    // silently stops matching - in exactly the pasted-from-a-document bilingual corpus
    // this feature exists for. An ASCII-only sample set passes whether or not the two
    // expressions agree on the input that matters.
    const samples = [
      "  Reports   go OUT on Fridays ",
      "MIXED   Case\tand\ttabs",
      "trailing space ",
      "a\u00A0b", // NBSP - the one that actually diverges
      "c\u2003d", // EM SPACE, from the U+2000-U+200A block
      "e\uFEFFf", // ZERO WIDTH NO-BREAK SPACE
    ];
    for (const [i, s] of samples.entries()) {
      await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [`${P}nn${i}`, SPACE_A]);
      await insertDoc(`${P}dn${i}`, `${P}nn${i}`, "claim", s, s, s);
      const r = await q(
        `SELECT norm_title, norm_owner_text, norm_model_text FROM vault_search_documents WHERE id = $1`,
        [`${P}dn${i}`],
      );
      expect(r.rows[0].norm_title).toBe(norm(s));
      expect(r.rows[0].norm_owner_text).toBe(norm(s));
      expect(r.rows[0].norm_model_text).toBe(norm(s));
    }
  });

  it("refuses a projection row that names a node in another space", async () => {
    // The composite FK the rest of the slice uses, applied here too. Without it a
    // projection row naming another space's node, or a node that no longer exists, is
    // representable - and the mints' relevance query reads this table before it joins
    // anything, so a cross-space id here is a cross-space candidate.
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      `${P}space-b`, `${P}proj`, OWNER,
    ]);
    await q(`INSERT INTO vault_nodes (id, space_id, kind) VALUES ($1,$2,'claim')`, [
      `${P}elsewhere`, `${P}space-b`,
    ]);
    await expect(insertDoc(`${P}d-cross`, `${P}elsewhere`, "claim", "", "x", "x")).rejects.toMatchObject({
      code: FK_VIOLATION,
      constraint: "vault_search_doc_node_fk",
    });
  });

  it("cascades away when its node is hard-deleted", async () => {
    // The only hard node delete in the system is the `spaces` cascade fired by
    // purgeUserSpaces; this FK is what keeps the projection from surviving it. It does
    // NOT stand in for the explicit inverse: a SOFT node delete fires nothing here, which
    // is why `deleteNode` and `deleteSpaceNodes` call `unprojectNode`/`unprojectSpace`
    // themselves (Task 9).
    await insertDoc(`${P}d-casc`, `${P}n1`, "claim", "", "x", "x");
    await q(`DELETE FROM vault_nodes WHERE id = $1`, [`${P}n1`]);
    const left = await q(`SELECT count(*)::int AS n FROM vault_search_documents WHERE id = $1`, [`${P}d-casc`]);
    expect(left.rows[0].n).toBe(0);
  });

  it("leaves norm_model_text NULL when there is no model-facing text", async () => {
    await insertDoc(`${P}d2`, `${P}n1`, "claim", "", "a withheld statement", null);
    const r = await q(`SELECT norm_model_text, model_tsv FROM vault_search_documents WHERE id = $1`, [`${P}d2`]);
    expect(r.rows[0].norm_model_text).toBeNull();
    // The tsvector still exists (title || coalesce(model_text,'')) and is empty here,
    // which is what keeps a withheld row from matching through its own text.
    const hit = await q(
      `SELECT id FROM vault_search_documents
       WHERE space_id = $1 AND model_tsv @@ websearch_to_tsquery('simple', $2)`,
      [SPACE_A, "withheld"],
    );
    expect(hit.rows).toHaveLength(0);
  });

  it("matches on a trigram near-miss", async () => {
    await insertDoc(`${P}d3`, `${P}n1`, "claim", "", "postachalnyk acme", "postachalnyk acme");
    const r = await q(
      `SELECT id FROM vault_search_documents WHERE space_id = $1 AND norm_model_text % $2`,
      [SPACE_A, "postachalnik acme"],
    );
    expect(r.rows).toHaveLength(1);
  });

  it("holds one row per searchable unit", async () => {
    await insertDoc(`${P}d4`, `${P}n1`, "claim", "", "one", "one");
    await expect(insertDoc(`${P}d5`, `${P}n1`, "claim", "", "two", "two")).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: "uniq_vsearch_unit",
    });
  });

  it("cascades away with the space", async () => {
    await insertDoc(`${P}d6`, `${P}n1`, "claim", "", "one", "one");
    await q(`DELETE FROM spaces WHERE id = $1`, [SPACE_A]);
    const r = await q(`SELECT count(*)::int AS n FROM vault_search_documents WHERE space_id = $1`, [SPACE_A]);
    expect(r.rows[0].n).toBe(0);
  });
});
