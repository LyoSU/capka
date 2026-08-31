import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * ONE ROUTE FROM STORED TEXT TO THE MODEL.
 *
 * A source-text test, for the same reason `memory-statement.test.ts` is one: the rule it
 * guards is about which module a decision lives in, and no behavioural test can observe
 * that a SECOND module has started making the same decision correctly. It only notices
 * when the second copy goes wrong, which is months later and by then in a prompt.
 *
 * The structural half of the fix is the per-channel brands: the MINTS
 * (`listManifestClaims`, `listManifestTopics`, `listMemoryToolRows`, `modelTextOf`) hand
 * back strings nothing else can mint, and the model-facing formatters accept only those,
 * so an accidental bypass fails `tsc`. What a type cannot catch is a deliberate
 * `as ManifestText`, or a reader that quietly grows its own `WHERE` clause. That is what
 * this file is for.
 *
 * And the decision the mints own is no longer ONE `WHERE`: it is a channel clause over
 * `prompt_access` — three arms of it, one per tier — ANDed with a liveness arm per node
 * kind. That is more surface, not less, which is precisely why owning it in one module
 * matters more now than it did when the whole rule fitted on one line.
 *
 * The count that matters: this feature has produced twelve instances of one defect —
 * a rule at one entrance while a second walks past it — and the eleventh was found only
 * because an enumeration built from one accessor's call sites MISSED a fifth reader that
 * reached claim text another way. Enumerating entrances has demonstrably failed. Owning
 * the decision in one module, and asserting that, is the thing that has not been tried.
 */

/** The module that owns the decision. */
const OWNER = "src/lib/vault/model-view.ts";

/** Every module that builds text for a provider prompt. Add one here and the assertions
 *  below apply to it; that is the intended way to extend this list, and the reason it is
 *  a list rather than a directory walk is that "model-facing" is a judgment about
 *  AUDIENCE, which no path pattern encodes. */
const MODEL_FACING = ["src/lib/vault/manifest.ts", "src/lib/vault/tools.ts", "src/lib/vault/write-tools.ts"];

/** Accessors that return claim text with NO admission decision attached. They exist for
 *  callers that must see every row — the ledger's dedup, the confirm path, the human
 *  page — and every one of those has an audience that is the owner of the data. */
const UNFILTERED = /\b(listHeadClaims|headBySlot)\b/;

const read = (p: string) => readFileSync(p, "utf8");

/** Lines that USE a name, ignoring prose. A comment explaining why a reader must not
 *  reach for `listHeadClaims` is not a second implementation of the rule, and banning
 *  the word would push the reasoning out of the files that need it most — the same
 *  distinction `memory-statement.test.ts` draws. */
const code = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"))
    .join("\n");

/** Every non-test `.ts`/`.tsx` under `src/`, read once, prose stripped.
 *
 *  A WALK, not a list, and that is the point. The guards below used to iterate a
 *  hand-written array of four files, which made each of them a claim about the files
 *  someone remembered — while this module's own docstring argues that enumerating
 *  entrances has demonstrably failed. The slice proved the docstring twice: it added
 *  `search-documents.ts` and an admin reindex route as new entrances to the projection and
 *  put neither in any array, and a real second-reader idiom (the table named inside a raw
 *  `sql` template) walked past the guard until the REGEX was widened — the list never was.
 *
 *  Inverted, the assertion becomes "these files and no others", which binds a file that
 *  does not exist yet. That is the only form of these guards that can still hold when
 *  slice 2 adds note versions, a dedup reader and an ingest path. */
const ALL_SRC: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.set(p, code(read(p)));
      }
    }
  };
  walk("src");
  return out;
})();

/** Which files' CODE — never their prose — mention `re`, sorted so the expectation reads
 *  as a roster. A comment explaining why a module must NOT reach for something is not a
 *  second implementation of the rule; see `code`. */
const hits = (re: RegExp) =>
  [...ALL_SRC]
    .filter(([, c]) => re.test(c))
    .map(([f]) => f)
    .sort();

describe("the model-facing readers go through one projection", () => {
  // THREE CONTROLS WERE DELETED HERE, not weakened, and the difference matters. Task 11
  // removed `listModelClaims`, `modelVisible` and the single `ModelText` brand, so the
  // "finds the files" control naming that export, the `/as ModelText\b/` caster count and
  // the `reviewStatus, "confirmed"` writer count were all asserting about subjects that no
  // longer exist — each of them would have gone red on a codebase that is CORRECT. Their
  // replacements are the three-brand and `prompt_access` assertions in the next describe,
  // which assert the same properties about the rules that replaced them.

  it("no model-facing module reads claim text through an unfiltered accessor", () => {
    const offenders = MODEL_FACING.filter((f) => UNFILTERED.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it("leaves no second reader of the search projection", () => {
    // A tool, a page, a ledger or a route that queried vault_search_documents directly
    // would be a second entrance carrying whatever predicate its author remembered.
    //
    // BOTH idioms, because the owner itself uses the second one: the fused query in
    // model-view.ts names the table inside a raw `sql` template, so a copy of it into
    // another module would carry no `vaultSearchDocuments` identifier and a guard that
    // greps only the Drizzle symbol would pass a second reader written the owner's own way.
    //
    // The roster, and why each is on it — add one here only with a reason:
    //   schema.ts            declares the table.
    //   model-view.ts        the mints, which are the only model-facing readers.
    //   search-documents.ts  the writer and its two inverses.
    // `nodes.ts` and the admin reindex route are entrances to the projection and are
    // deliberately ABSENT: both go through search-documents.ts's functions and neither
    // names the table in code, which is exactly the property this asserts.
    expect(hits(/vaultSearchDocuments|vault_search_documents/)).toEqual([
      "src/lib/db/schema.ts",
      "src/lib/vault/model-view.ts",
      "src/lib/vault/search-documents.ts",
    ]);
  });

  it("has no listModelClaims and no modelVisible left anywhere", () => {
    // The single-brand predicate is gone, not shadowed: two ways to ask "may the model
    // read this" is the defect this module exists to prevent, and a surviving old one is
    // the second way.
    const files = [OWNER, ...MODEL_FACING, "src/lib/vault/candidates.ts"];
    for (const f of files) {
      expect(code(read(f))).not.toMatch(/\blistModelClaims\b/);
      expect(code(read(f))).not.toMatch(/\bmodelVisible\b/);
    }
  });

  it("keeps the legacy free-text fallback deleted", () => {
    // H2. `legacyDoc` read up to 4096 raw characters of an unmigrated `memory_docs` row
    // straight into the system prompt, behind a block quote that governs how the model is
    // ASKED to read bytes it has already received. It is gone, and the manifest no longer
    // touches that table at all — which is a stronger statement than "it is gated".
    const manifest = code(read("src/lib/vault/manifest.ts"));
    expect(manifest).not.toMatch(/\bmemoryDocs\b/);
    expect(manifest).not.toMatch(/\bnotCarried\b/);
  });
});

describe("the three channels", () => {
  it("mints each brand in exactly one module, and never widens between them", () => {
    // A wrapper object would be constructible by anyone; three distinct `unique symbol`s
    // put the discrimination in the type system, where a bypass fails tsc. What a type
    // cannot catch is a deliberate cast, so that is what this asserts.
    // `EvidenceText` is expected to be minted NOWHERE in this slice: the mint that
    // produces it (`listEvidenceRows`) ships with its only reader, `knowledge_search`.
    // The assertion is the same one in both cases — nobody but the owner casts — and
    // writing the empty list out is what keeps that from being read as "the mint moved".
    const expected: Record<string, string[]> = {
      ManifestText: [OWNER],
      MemoryToolText: [OWNER],
      EvidenceText: [],
      // THE STRUCTURAL CURE for what the deleted `it("lets only the confirm path choose a
      // manifest-tier source class")` guarded, and it REPLACES that test rather than
      // joining it — as its own comment said slice 2 would: "a type that cannot express
      // the wrong call beats a grep for one". `ClaimInput.sourceClass` is `ServerClass`,
      // so the blind spot the old guard NAMED — a class computed into a variable and
      // passed as `sourceClass: cls` — is now closed by `tsc` rather than by a pattern,
      // and so is the narrower residue slice 1 recorded but did not name in the test: the
      // old regex matched double-quoted literals only, so `sourceClass: 'owner_authored'`
      // would have passed it. A brand has no quote style.
      ServerClass: ["src/lib/vault/grounding.ts"],
    };
    for (const [brand, want] of Object.entries(expected)) {
      expect(hits(new RegExp(`as ${brand}\\b`))).toEqual(want);
    }
    // The test-only minter stays in the tests. `ALL_SRC` skips `__tests__`, so
    // `fixtures.ts`'s cast is out of this walk's scope by construction — which is correct,
    // because a test cannot ship. This asserts it never migrates into a file that can.
    expect(hits(/testServerClass/)).toEqual([]);
    // No widening function: promotion must be impossible to express, not discouraged.
    expect(code(read(OWNER))).not.toMatch(/function\s+widen|toManifestText|asManifest\b/);
  });

  it("keeps the liveness arms side by side in the owner module and nowhere else", () => {
    // The invariant is not "one function"; it is "one module owns liveness". A fourth node
    // kind has to add a fourth arm HERE, beside the others, which is what makes the
    // omission visible - a bare shared fragment typed to one table was not that.
    const owner = code(read(OWNER));
    expect(owner).toMatch(/function liveClaimForModel\(/);
    expect(owner).toMatch(/function liveNoteForModel\(/);
    const others = [...MODEL_FACING, "src/lib/vault/candidates.ts", "src/lib/vault/memory-page.ts"];
    for (const f of others) {
      expect(code(read(f))).not.toMatch(/liveClaimForModel\s*\(\s*\)\s*\{|liveNoteForModel\s*\(\s*\)\s*\{/);
    }
    // The version join is the mint's obligation. A note-reading mint that forgot it would
    // compile and silently return every revision, so the arm's own text is asserted here:
    // if somebody deletes a clause, this fails rather than the manifest quietly widening.
    expect(owner).toMatch(/eq\(vaultNoteVersions\.revision,\s*vaultNotes\.currentRevision\)/);
    expect(owner).toMatch(/eq\(vaultNoteVersions\.sensitive,\s*false\)/);
  });

  it("writes the prompt_access channel clause in exactly one module", () => {
    // The SQL half, the same shape as the review_status assertion above it: a second
    // `prompt_access = 'manifest'` written out by hand somewhere is a second copy of the
    // rule even when it is correct today.
    //
    //   schema.ts      declares the generated column.
    //   claims.ts      READS it into `ClaimHead.promptAccess` and never selects on it —
    //                  the head shape has to carry the value for `modelTextOf` to switch
    //                  on. An exclusion, stated: it was previously silent, which reads as
    //                  an oversight rather than as the decision it is.
    //   model-view.ts  the owner: every channel clause, all three arms.
    //   notes.ts       READS it into `NoteHead.promptAccess` for `memory_open`'s channel
    //                  check to switch on, and never SELECTS on it — the same exclusion,
    //                  and the same reason, as `claims.ts` above. Stated rather than left
    //                  silent, because a silent entry reads as an oversight.
    //   write-tools.ts REPORTS it back on `memory_fact_write`'s return (§4.5's Returns
    //                  table), read off the row the write just made through
    //                  `findCurrentHead` — so the value is the generated column's, not a
    //                  channel clause this module decided. It does carry `accessOf`, which
    //                  is the class→channel map MINUS the `sensitive` arm, for §4.5 step
    //                  5's "equal or stronger" comparison; that is a rank over classes and
    //                  not an admission decision, and it is pinned against the database in
    //                  `fact-write.integration.test.ts` rather than trusted.
    expect(hits(/promptAccess|prompt_access/)).toEqual([
      "src/lib/db/schema.ts",
      "src/lib/vault/claims.ts",
      "src/lib/vault/model-view.ts",
      "src/lib/vault/notes.ts",
      "src/lib/vault/write-tools.ts",
    ]);
  });

  it("finds the files at all", () => {
    // The control, extended: a test pointed at a renamed export finds no violations and
    // passes for the wrong reason. It names every mint, so a rename cannot leave the
    // guards above pointing at nothing.
    //
    // The walk needs the same control and needs it more, because an empty walk is not
    // obviously empty: `hits()` would return [] for every pattern, and the one expectation
    // in this file whose answer IS [] (`as EvidenceText`) would pass while asserting
    // nothing at all. So: it found a codebase, and it found the owner inside it.
    expect(ALL_SRC.size).toBeGreaterThan(200);
    expect(ALL_SRC.has(OWNER)).toBe(true);
    for (const f of MODEL_FACING) expect(ALL_SRC.has(f)).toBe(true);
    expect(read(OWNER)).toContain("export async function listManifestClaims");
    expect(read(OWNER)).toContain("export async function listManifestTopics");
    expect(read(OWNER)).toContain("export async function listMemoryToolRows");
    for (const f of MODEL_FACING) expect(read(f).length).toBeGreaterThan(0);
  });
});
