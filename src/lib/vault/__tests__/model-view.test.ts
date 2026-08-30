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
 * The structural half of the fix is the `ModelText` brand: `listModelClaims` and
 * `modelTextOf` hand back strings nothing else can mint, and the model-facing formatters
 * accept only those, so an accidental bypass fails `tsc`. What a type cannot catch is a
 * deliberate `as ModelText`, or a reader that quietly grows its own `WHERE` clause. That
 * is what this file is for.
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
  it("finds the files at all", () => {
    // The control. A test pointed at a mistyped path finds no violations and passes for
    // the wrong reason — which, on a guard whose whole job is to fail later, is
    // indistinguishable from working.
    expect(read(OWNER)).toContain("export async function listModelClaims");
    for (const f of MODEL_FACING) expect(read(f).length).toBeGreaterThan(0);
  });

  it("no model-facing module reads claim text through an unfiltered accessor", () => {
    const offenders = MODEL_FACING.filter((f) => UNFILTERED.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it("mints the brand in exactly one module", () => {
    // `as ModelText` is the escape hatch the type cannot close. It must exist — the
    // projection has to produce the branded value somehow — and it must exist ONCE.
    const casters = [OWNER, ...MODEL_FACING, "src/lib/vault/candidates.ts", "src/lib/vault/claims.ts"].filter((f) =>
      /as ModelText\b/.test(code(read(f))),
    );
    expect(casters).toEqual([OWNER]);
  });

  it("writes the admission predicate in exactly one module", () => {
    // The SQL half. A second `review_status = 'confirmed' AND sensitive = false` written
    // out by hand somewhere is a second copy of the rule even if it is correct today —
    // and one of the three copies this replaced was NOT correct, for a whole plan.
    const files = [OWNER, ...MODEL_FACING, "src/lib/vault/candidates.ts"];
    const writers = files.filter((f) => /reviewStatus,\s*"confirmed"/.test(code(read(f)).replace(/\s+/g, " ")));
    expect(writers).toEqual([OWNER]);
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
