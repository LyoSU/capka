import { describe, it, expect } from "vitest";
import { fitStatement, normalizedHashOf } from "@/lib/vault/claims";

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

  it("freezes the CLAMP into the key format, for a statement past STATEMENT_MAX_CHARS", () => {
    // The four pins above cannot see `fitStatement` at all: `normalizedHashOf` never calls
    // it — the writers hand it an already-clamped statement — so every literal short enough
    // to pass through the clamp untouched leaves `STATEMENT_MAX_CHARS` free to move without
    // reddening anything. This pin closes that by hashing the COMPOSITION the writers
    // actually perform, over an input long enough that the clamp is load-bearing.
    //
    // Composing a live function here is deliberate and is the opposite of the rule the
    // other pins follow: there the normalizer must not compute its own expected input,
    // whereas here `fitStatement` IS the thing being frozen, and the expected value is
    // still a literal digest that a changed clamp cannot follow.
    const long = "Pays in EUR and always emails invoices on the last Friday of the month. ".repeat(12);
    expect(long.length).toBeGreaterThan(500); // the clamp must actually engage
    expect(fitStatement(long)).toHaveLength(500);
    expect(normalizedHashOf(fitStatement(long), null)).toBe(
      "6691686965b805e3c06261dcd28362eb4424f7f6a32a470681e33349262af3c9",
    );
    // And the clamp is what makes that digest: the unclamped text hashes to something else,
    // so a clamp that stopped firing could not quietly produce the same key.
    expect(normalizedHashOf(long, null)).not.toBe(
      "6691686965b805e3c06261dcd28362eb4424f7f6a32a470681e33349262af3c9",
    );
  });
});
