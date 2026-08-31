import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

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
const MODEL_FACING = ["src/lib/vault/manifest.ts", "src/lib/vault/tools.ts"];

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
    // The mints are the only readers. A tool, a page or a ledger that queried
    // vault_search_documents directly would be a second entrance carrying whatever
    // predicate its author remembered.
    const others = [...MODEL_FACING, "src/lib/vault/candidates.ts", "src/lib/vault/memory-page.ts"];
    for (const f of others) expect(code(read(f))).not.toMatch(/vaultSearchDocuments/);
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
    const files = [OWNER, ...MODEL_FACING, "src/lib/vault/candidates.ts", "src/lib/vault/claims.ts"];
    // `EvidenceText` is expected to be minted NOWHERE in this slice: the mint that
    // produces it (`listEvidenceRows`) ships with its only reader, `knowledge_search`.
    // The assertion is the same one in both cases — nobody but the owner casts — and
    // writing the empty list out is what keeps that from being read as "the mint moved".
    const expected: Record<string, string[]> = {
      ManifestText: [OWNER],
      MemoryToolText: [OWNER],
      EvidenceText: [],
    };
    for (const [brand, want] of Object.entries(expected)) {
      const casters = files.filter((f) => new RegExp(`as ${brand}\\b`).test(code(read(f))));
      expect(casters).toEqual(want);
    }
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
  });

  it("writes the prompt_access channel clause in exactly one module", () => {
    // The SQL half, the same shape as the review_status assertion above it: a second
    // `prompt_access = 'manifest'` written out by hand somewhere is a second copy of the
    // rule even when it is correct today.
    const files = [OWNER, ...MODEL_FACING, "src/lib/vault/candidates.ts", "src/lib/vault/memory-page.ts"];
    const writers = files.filter((f) => /promptAccess/.test(code(read(f))));
    expect(writers).toEqual([OWNER]);
  });

  it("finds the files at all", () => {
    // The control, extended: a test pointed at a renamed export finds no violations and
    // passes for the wrong reason. It names every mint, so a rename cannot leave the
    // guards above pointing at nothing.
    expect(read(OWNER)).toContain("export async function listManifestClaims");
    expect(read(OWNER)).toContain("export async function listManifestTopics");
    expect(read(OWNER)).toContain("export async function listMemoryToolRows");
    for (const f of MODEL_FACING) expect(read(f).length).toBeGreaterThan(0);
  });
});
