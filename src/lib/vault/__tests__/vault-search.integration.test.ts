import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run <this file>
 *
 * THE TWO-LANE SEARCH, and above all the join that makes it honest. The projection holds
 * text and ids only; the mint selects candidates there and then joins the authoritative
 * subtype row, applying the full liveness predicate to it. So the assertions that matter
 * most are the ones where the projection still HOLDS a row and the mint must not return
 * it - a superseded claim, a retired one, a sensitive one. A test that only checked
 * "searching for a word finds the word" would pass with the join deleted.
 */
import { pool } from "@/lib/db";
import { createClaim, updateClaim, type Actor, type SourceClass } from "../claims";
import { listMemoryToolRows } from "../model-view";
import { testServerClass } from "./fixtures";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const P = "vsearchtest-";
const OWNER = `${P}owner`;
const SPACE_A = `${P}space-a`;
const SPACE_B = `${P}space-b`;
const ACTOR: Actor = { kind: "user", id: OWNER };
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const cleanup = () => q(`DELETE FROM spaces WHERE id LIKE $1`, [`${P}%`]);

// No SQLSTATE constants here: this suite asserts on returned ROWS, never on a raised
// error. `search-documents.integration.test.ts` declares them because it does.

const found = async (spaceIds: string[], query: string) =>
  (await listMemoryToolRows(spaceIds, { queries: [query], limit: 20 })).rows.map((r) => String(r.excerpt));

run("vault: two-lane memory search", () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1,'search test',$2,true,now(),now()) ON CONFLICT DO NOTHING`,
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
    await q(`INSERT INTO spaces (id, type, ref_id, owner_user_id) VALUES ($1,'project',$2,$3)`, [
      SPACE_B, `${P}proj`, OWNER,
    ]);
  });

  // `SourceClass`, not the default's own literal type: `= "agent_inferred" as const` would
  // narrow the PARAMETER to that one value and every call passing another class would fail
  // to compile - which is most of the channel assertions below. The `ServerClass` brand is
  // minted HERE rather than at each call site, so the twenty-odd callers below stay
  // readable positional literals.
  const seed = (spaceId: string, statement: string, sourceClass: SourceClass = "agent_inferred", sensitive = false) =>
    createClaim(
      { spaceId, statement, origin: { kind: "test" }, sourceClass: testServerClass(sourceClass), sensitive },
      ACTOR,
    );

  it("finds a token match through the lexical lane", async () => {
    await seed(SPACE_A, "the quarterly report goes out on friday");
    await seed(SPACE_A, "the office door code changed");
    expect(await found([SPACE_A], "quarterly report")).toEqual(["the quarterly report goes out on friday"]);
  });

  it("finds a near-miss through the trigram lane that the lexical lane cannot", async () => {
    // The whole reason there are two lanes: a misspelling has no token in common.
    await seed(SPACE_A, "postachalnyk acme invoices");
    expect(await found([SPACE_A], "postachalnik acme")).toEqual(["postachalnyk acme invoices"]);
  });

  it("returns nothing for a word that appears nowhere", async () => {
    await seed(SPACE_A, "the quarterly report goes out on friday");
    expect(await found([SPACE_A], "helicopter")).toEqual([]);
  });

  it("does NOT return a superseded claim whose projection row still exists", async () => {
    // H7 in one assertion. The predecessor is still in vault_search_documents by design -
    // the projection carries no lifecycle state - so if this returns two rows, the mint
    // stopped joining the authoritative row.
    const c = await seed(SPACE_A, "the deadline is on monday");
    const upd = await updateClaim({
      claimId: c.id, expectedRevision: c.revision, patch: { statement: "the deadline is on tuesday" },
      sourceClass: testServerClass("agent_inferred"), allowedSpaceIds: [SPACE_A], actor: ACTOR,
    });
    expect(upd.ok).toBe(true);
    const projected = await q(
      `SELECT count(*)::int AS n FROM vault_search_documents WHERE space_id = $1 AND owner_text LIKE '%deadline%'`,
      [SPACE_A],
    );
    expect(projected.rows[0].n).toBe(2);
    expect(await found([SPACE_A], "deadline")).toEqual(["the deadline is on tuesday"]);
  });

  it("does NOT return a retired claim whose projection row still exists", async () => {
    const c = await seed(SPACE_A, "an old arrangement");
    await q(`UPDATE vault_claims SET retired_at = now() WHERE id = $1`, [c.id]);
    expect(await found([SPACE_A], "arrangement")).toEqual([]);
  });

  it("does NOT return a sensitive claim, and cannot match on its words", async () => {
    await seed(SPACE_A, "a private diagnosis", "owner_authored", true);
    expect(await found([SPACE_A], "diagnosis")).toEqual([]);
  });

  it("returns knowledge_search-class rows to nobody on this channel", async () => {
    await seed(SPACE_A, "read from a document", "untrusted_derived");
    await seed(SPACE_A, "read from a chat", "agent_inferred");
    expect(await found([SPACE_A], "read from")).toEqual(["read from a chat"]);
  });

  it("admits both manifest-class and memory_search-class rows", async () => {
    await seed(SPACE_A, "owner said this", "owner_authored");
    await seed(SPACE_A, "agent concluded this", "agent_inferred");
    const got = await found([SPACE_A], "this");
    expect(got.sort()).toEqual(["agent concluded this", "owner said this"]);
  });

  it("searches only the spaces it was given", async () => {
    await seed(SPACE_A, "a personal fact about pears");
    await seed(SPACE_B, "a project fact about pears");
    expect(await found([SPACE_A], "pears")).toEqual(["a personal fact about pears"]);
    expect((await found([SPACE_A, SPACE_B], "pears")).length).toBe(2);
  });

  it("fuses across several queries", async () => {
    await seed(SPACE_A, "the invoice is due");
    await seed(SPACE_A, "rakhunok terminy oplaty");
    const { rows } = await listMemoryToolRows([SPACE_A], { queries: ["invoice", "rakhunok"], limit: 20 });
    expect(rows.length).toBe(2);
  });

  it("honours the limit after filtering, not before", async () => {
    // "Filtering happens after fusion and before the limit, so a retired or superseded row
    // cannot consume a slot." Two live rows and one retired one, limit 2: if the limit ran
    // first the retired row would eat a slot and only one live row would come back.
    for (const s of ["match one here", "match two here", "match three here"]) await seed(SPACE_A, s);
    await q(`UPDATE vault_claims SET retired_at = now() WHERE statement = $1`, ["match one here"]);
    const { rows } = await listMemoryToolRows([SPACE_A], { queries: ["match here"], limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => String(r.excerpt)).sort()).toEqual(["match three here", "match two here"]);
  });

  it("with no queries, returns every eligible row newest first", async () => {
    // The dedup caller's shape: "does the model already know this" asks about the whole
    // eligible set, not about a query.
    await seed(SPACE_A, "first");
    await seed(SPACE_A, "second");
    const { rows } = await listMemoryToolRows([SPACE_A]);
    expect(rows.map((r) => String(r.excerpt))).toEqual(["second", "first"]);
  });

  it("stamps last_used_at on the rows it returns, and on nothing else", async () => {
    // M1: written INSIDE the mint, not by its callers. "One place, because two would
    // drift" is only true if the place is the mint.
    const hit = await seed(SPACE_A, "the returned one");
    const miss = await seed(SPACE_A, "the other one");
    await found([SPACE_A], "returned");
    const r = await q(`SELECT id, last_used_at FROM vault_claims WHERE id = ANY($1)`, [[hit.id, miss.id]]);
    const by = Object.fromEntries(
      r.rows.map((x: { id: string; last_used_at: Date | null }) => [x.id, x] as const),
    );
    expect(by[hit.id].last_used_at).not.toBeNull();
    expect(by[miss.id].last_used_at).toBeNull();
  });

  it("stamps NOTHING on the no-queries read", async () => {
    // The second entrance, and the one the test above walks past. `proposeCandidate` calls
    // the no-queries branch on the hot path of post-turn extraction, inside its own
    // transaction — so a stamp there would re-timestamp every live claim in the space on
    // every turn, take a row lock over the whole space while doing it, and convert the
    // retention signal slice 4's job reads from "the model read this" into "the user had
    // a turn". An unstamped use is a smaller error than a space-wide stamp that destroys
    // the signal.
    const a = await seed(SPACE_A, "alpha");
    const b = await seed(SPACE_A, "beta");
    await listMemoryToolRows([SPACE_A]);
    const r = await q(`SELECT id, last_used_at FROM vault_claims WHERE id = ANY($1)`, [[a.id, b.id]]);
    for (const row of r.rows) expect(row.last_used_at).toBeNull();
  });

  it("stamps only the rows the LIMIT actually returned", async () => {
    // Not "everything that matched": the promise is "the rows the model received".
    for (const s of ["gamma one", "gamma two", "gamma three"]) await seed(SPACE_A, s);
    const { rows } = await listMemoryToolRows([SPACE_A], { queries: ["gamma"], limit: 1 });
    expect(rows).toHaveLength(1);
    const stamped = await q(
      `SELECT count(*)::int AS n FROM vault_claims WHERE space_id = $1 AND last_used_at IS NOT NULL`,
      [SPACE_A],
    );
    expect(stamped.rows[0].n).toBe(1);
  });
});
