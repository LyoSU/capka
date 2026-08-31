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
import { createClaim, updateClaim, forgetClaim, confirmClaim, type Actor } from "../claims";
import { rebuildSearchDocuments } from "../search-documents";
import { DEFAULT_TOPIC_KEY, getOrCreateTopicNote } from "../spaces";
import { norm } from "../text";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const P = "vsdoctest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`;
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);
const ACTOR: Actor = { kind: "user", id: OWNER };

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
    // BOTH columns, which the plural in the name always promised. `owner_tsv` was the one
    // generated column nothing in the repo read: dropping it and its index left every test
    // in this file green, and `tsc` cannot see a column either. The owner lane is the one
    // the memory page searches, so losing it silently is not a smaller failure than losing
    // the model lane - it is the same failure on the surface a person actually uses.
    await insertDoc(`${P}d1`, `${P}n1`, "claim", "", "reports go out on fridays", "reports go out on fridays");
    const hit = await q(
      `SELECT id FROM vault_search_documents
       WHERE model_tsv @@ websearch_to_tsquery('simple', $1) AND space_id = $2`,
      ["fridays", SPACE_A],
    );
    expect(hit.rows).toHaveLength(1);
    const ownerHit = await q(
      `SELECT id FROM vault_search_documents
       WHERE owner_tsv @@ websearch_to_tsquery('simple', $1) AND space_id = $2`,
      ["fridays", SPACE_A],
    );
    expect(ownerHit.rows).toHaveLength(1);
    await expect(
      q(
        `INSERT INTO vault_search_documents (id, space_id, node_id, kind, owner_text, model_tsv)
         VALUES ($1,$2,$3,'claim','x', to_tsvector('simple','x'))`,
        [`${P}d-bad`, SPACE_A, `${P}n2`],
      ),
    ).rejects.toMatchObject({ code: GENERATED_ALWAYS });
    await expect(
      q(
        `INSERT INTO vault_search_documents (id, space_id, node_id, kind, owner_text, owner_tsv)
         VALUES ($1,$2,$3,'claim','x', to_tsvector('simple','x'))`,
        [`${P}d-bad2`, SPACE_A, `${P}n2`],
      ),
    ).rejects.toMatchObject({ code: GENERATED_ALWAYS });
  });

  it("keeps all four GIN indexes, with the operator classes the lanes need", async () => {
    // `@@` and `%` are plain operators: they answer IDENTICALLY with the index dropped,
    // with the wrong operator class, or with no index at all - only slower. So every other
    // test in this file stays green through exactly the regression that turns the trigram
    // lane into a sequential scan over every claim in the instance, and a regenerate of the
    // migration is the event most likely to cause it. The operator class is asserted, not
    // just the index: `gin_trgm_ops` is the half a plain `CREATE INDEX USING gin` omits.
    const r = await q(
      `SELECT c.relname AS index_name, am.amname, op.opcname
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am am ON am.oid = c.relam
         JOIN pg_opclass op ON op.oid = i.indclass[0]
        WHERE c.relname IN ('vault_search_owner_fts','vault_search_model_fts',
                            'vault_search_owner_trgm','vault_search_model_trgm')
        ORDER BY c.relname`,
    );
    expect(r.rows).toEqual([
      { index_name: "vault_search_model_fts", amname: "gin", opcname: "tsvector_ops" },
      { index_name: "vault_search_model_trgm", amname: "gin", opcname: "gin_trgm_ops" },
      { index_name: "vault_search_owner_fts", amname: "gin", opcname: "tsvector_ops" },
      { index_name: "vault_search_owner_trgm", amname: "gin", opcname: "gin_trgm_ops" },
    ]);
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

  it("leaves norm_model_text NULL when the body text is withheld", async () => {
    await insertDoc(`${P}d2`, `${P}n1`, "claim", "", "a withheld statement", null);
    const r = await q(`SELECT norm_model_text, model_tsv FROM vault_search_documents WHERE id = $1`, [`${P}d2`]);
    expect(r.rows[0].norm_model_text).toBeNull();
    // The BODY does not reach the model lane, in either column.
    const hit = await q(
      `SELECT id FROM vault_search_documents
       WHERE space_id = $1 AND model_tsv @@ websearch_to_tsquery('simple', $2)`,
      [SPACE_A, "withheld"],
    );
    expect(hit.rows).toHaveLength(0);
  });

  it("does NOT withhold a title from the model FTS lane, whatever model_text says", async () => {
    // The correction to this file's earlier claim, asserted rather than remembered.
    // `model_tsv` is `to_tsvector('simple', title || ' ' || coalesce(model_text,''))`, so a
    // withheld row with a NON-EMPTY title is still matchable through that title - while
    // `norm_model_text` drops the title entirely, so the two model-lane columns disagree.
    // The old fixture passed `title: ''` and therefore proved only the empty-title case
    // while its comment claimed the general one.
    //
    // This is not a leak in the shipped system, and the reason is NOT this column:
    // `projectClaimDoc` gives every claim an empty title (a claim is the only withholdable
    // kind), and the mints join the authoritative row and apply `prompt_access` before
    // returning anything. What this test pins is what the TABLE does, so nobody reads
    // `model_tsv` alone and believes a NULL `model_text` gated it.
    await insertDoc(`${P}d2t`, `${P}n1`, "claim", "quarterly severance schedule", "body text", null);
    const byTitle = await q(
      `SELECT id FROM vault_search_documents
       WHERE space_id = $1 AND model_tsv @@ websearch_to_tsquery('simple', $2)`,
      [SPACE_A, "severance"],
    );
    expect(byTitle.rows).toHaveLength(1);
    const r = await q(`SELECT norm_model_text FROM vault_search_documents WHERE id = $1`, [`${P}d2t`]);
    expect(r.rows[0].norm_model_text).toBeNull();
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

run("vault_search_documents: written and unwritten by the same transaction as the row", () => {
  const docFor = async (nodeId: string) =>
    (
      await q(`SELECT kind, title, owner_text, model_text FROM vault_search_documents WHERE node_id = $1`, [nodeId])
    ).rows[0] ?? null;

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
  });

  it("projects a claim when createClaim writes it", async () => {
    const c = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "reports go out on fridays",
        origin: { kind: "test" },
        sourceClass: "owner_authored",
      },
      ACTOR,
    );
    expect(await docFor(c.id)).toMatchObject({
      kind: "claim",
      owner_text: "reports go out on fridays",
      model_text: "reports go out on fridays",
    });
  });

  it("withholds model_text for a sensitive claim, and keeps owner_text", async () => {
    // The owner surface must still find it; the model channel must have nothing to match.
    const c = await createClaim(
      {
        spaceId: SPACE_A,
        statement: "a private matter",
        origin: { kind: "test" },
        sensitive: true,
        sourceClass: "owner_authored",
      },
      ACTOR,
    );
    expect(await docFor(c.id)).toMatchObject({ owner_text: "a private matter", model_text: null });
    // AND its title is empty, which is the half the table itself does not enforce: a
    // withheld row with a title stays matchable through `model_tsv` (asserted next door in
    // the shape suite). The writers are what make that shape unreachable, so this is the
    // assertion that would redden if `projectClaimDoc` ever started titling a claim.
    expect((await docFor(c.id)).title).toBe("");
    const leaked = await q(
      `SELECT count(*)::int AS n FROM vault_search_documents
       WHERE space_id = $1 AND model_text IS NULL AND title <> ''`,
      [SPACE_A],
    );
    expect(leaked.rows[0].n).toBe(0);
  });

  it("re-projects when the owner raises sensitivity", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "was public", origin: { kind: "test" }, sourceClass: "owner_authored" },
      ACTOR,
    );
    expect((await docFor(c.id)).model_text).toBe("was public");
    const hit = await confirmClaim(c.id, true, ACTOR);
    expect(hit).toBe(true);
    expect((await docFor(c.id)).model_text).toBeNull();
  });

  it("projects the successor and re-projects the predecessor on a supersede", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "before", origin: { kind: "test" }, sourceClass: "owner_authored" },
      ACTOR,
    );
    const upd = await updateClaim({
      claimId: c.id,
      expectedRevision: c.revision,
      patch: { statement: "after" },
      sourceClass: "owner_authored",
      allowedSpaceIds: [SPACE_A],
      actor: ACTOR,
    });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    // BOTH rows stay in the projection - the predecessor is a live NODE with a
    // superseded CLAIM, and it is the mint's join that hides it, not its absence here.
    // That is the H7 property under test: no lifecycle state lives in this table.
    expect(await docFor(c.id)).not.toBeNull();
    expect((await docFor(upd.id)).owner_text).toBe("after");
  });

  it("removes the row when the node is soft-deleted", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "forget me", origin: { kind: "test" }, sourceClass: "owner_authored" },
      ACTOR,
    );
    await forgetClaim({ claimId: c.id, expectedRevision: c.revision, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    expect(await docFor(c.id)).toBeNull();
  });

  it("projects a topic note by title", async () => {
    const id = await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    expect(await docFor(id)).toMatchObject({ kind: "note", title: "General" });
  });

  it("rebuildSearchDocuments reproduces exactly what the writers wrote", async () => {
    // The repair has to be a FUNCTION of the subtype tables, or it is not a repair. Wipe
    // the projection, rebuild, and compare the rows - not the count, which a rebuild that
    // wrote the wrong text would also match.
    await createClaim(
      { spaceId: SPACE_A, statement: "alpha", origin: { kind: "test" }, sourceClass: "owner_authored" },
      ACTOR,
    );
    await createClaim(
      {
        spaceId: SPACE_A,
        statement: "beta",
        origin: { kind: "test" },
        sensitive: true,
        sourceClass: "owner_authored",
      },
      ACTOR,
    );
    await getOrCreateTopicNote(SPACE_A, DEFAULT_TOPIC_KEY);
    const before = await q(
      `SELECT node_id, kind, title, owner_text, model_text FROM vault_search_documents
       WHERE space_id = $1 ORDER BY node_id`,
      [SPACE_A],
    );
    expect(before.rows.length).toBe(3);
    await q(`DELETE FROM vault_search_documents WHERE space_id = $1`, [SPACE_A]);
    const { written } = await rebuildSearchDocuments(SPACE_A);
    expect(written).toBe(3);
    const after = await q(
      `SELECT node_id, kind, title, owner_text, model_text FROM vault_search_documents
       WHERE space_id = $1 ORDER BY node_id`,
      [SPACE_A],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("rebuild skips a soft-deleted node", async () => {
    const c = await createClaim(
      { spaceId: SPACE_A, statement: "gone", origin: { kind: "test" }, sourceClass: "owner_authored" },
      ACTOR,
    );
    await forgetClaim({ claimId: c.id, expectedRevision: c.revision, allowedSpaceIds: [SPACE_A], actor: ACTOR });
    await q(`DELETE FROM vault_search_documents WHERE space_id = $1`, [SPACE_A]);
    await rebuildSearchDocuments(SPACE_A);
    expect(await docFor(c.id)).toBeNull();
  });
});
