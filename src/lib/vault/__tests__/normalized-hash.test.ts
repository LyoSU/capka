import { describe, it, expect } from "vitest";
import { normalizedHashOf } from "@/lib/vault/claims";

/**
 * Pure unit test: no database, no writer. This pins `normalizedHashOf`'s output BYTE FOR
 * BYTE for fixed inputs, because its whole job is to NEVER change — its output is stored
 * in `vault_claims.normalized_hash` under `idx_vclaims_norm_hash` (`schema.ts`), and the
 * slice-2 exact-dedup read recognises an already-recorded fact by matching that exact
 * string forever. The sibling precedent is `migrate-memory-docs.test.ts`, which pins
 * `legacyIdemKeyNorm` for the same reason.
 *
 * The point of a LITERAL digest, rather than the relative assertions in
 * `claims.integration.test.ts` (`hashes[0] === hashes[1]`, `/^[0-9a-f]{64}$/`): every one
 * of these changes keeps a relative assertion green while moving every stored key —
 * the `\n` separator becoming a space or a colon, `canonicalValue`'s rendering of objects
 * or arrays, `STATEMENT_MAX_CHARS` moving off 500, or `dedupKeyNorm` being "consolidated"
 * back into `text.ts`'s `norm`, which is free to gain NFC or apostrophe folding by its own
 * docstring. Any of those reddens the two tests below and nothing else in the repo.
 *
 * The statement arguments are LITERAL strings on purpose. Computing an expected input
 * through any live normalizer would make this test agree with whatever the code currently
 * does, which is the one thing it must not do.
 */
describe("normalizedHashOf pins the idx_vclaims_norm_hash key format", () => {
  it("hashes a statement needing every fold, with a structured value", () => {
    // Leading/trailing space, a doubled internal space, and mixed case — so the fold, the
    // separator and the value rendering are all inside this one digest.
    expect(normalizedHashOf("  Reports  go OUT on Fridays ", { day: "fri" })).toBe(
      "60bfe6556f4e54d1bc581be5f5975bab672622aa59ad6f707d63d8d7c57ea153",
    );
  });

  it("hashes an already-normal statement with no value", () => {
    // The null-value arm: `canonicalValue(null)` must keep rendering "null", not "" and
    // not "undefined", or every valueless claim in the table re-keys at once.
    expect(normalizedHashOf("hello world", null)).toBe(
      "4d549a247d6ed8cc418f3f029e8d665da10f95cce4193080921a424d721cd507",
    );
  });

  it("folds to the SAME digest the already-normal form produces", () => {
    // The fold assertion, tied to the literal above rather than to itself: this is the
    // digest an existing "reports go out on fridays" row must carry, so the two forms
    // cannot drift apart without one of these three tests going red.
    expect(normalizedHashOf("reports go out on fridays", { day: "fri" })).toBe(
      "60bfe6556f4e54d1bc581be5f5975bab672622aa59ad6f707d63d8d7c57ea153",
    );
  });

  it("gives one digest to two objects whose members differ only in key order", () => {
    // `JSON.stringify` is insertion-ordered; the recursive sort in `canonicalValue` is what
    // makes these one key. Asserted against a literal so that losing the sort cannot be
    // hidden by both sides changing together.
    const expected = "c8f5765cc79c6ad9e109aee2804de24c90533ad3987f0dc2c8cebad95a69adf6";
    expect(normalizedHashOf("same fact", { a: 1, b: 2 })).toBe(normalizedHashOf("same fact", { b: 2, a: 1 }));
    expect(normalizedHashOf("same fact", { a: 1, b: 2 })).toBe(expected);
  });
});
