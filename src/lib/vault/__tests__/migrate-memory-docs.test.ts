import { describe, it, expect } from "vitest";
import { legacyIdemKeyNorm } from "@/lib/vault/migrate-memory-docs";

/**
 * Pure unit test: no database, no migration run. This pins `legacyIdemKeyNorm`'s output
 * for a fixed set of inputs, because its whole job is to NEVER change — its output is
 * embedded in `memory_candidates.idempotency_key` under the unique index
 * `uniq_mcand_idem` (`schema.ts`). If this function is ever "simplified" back into a call
 * to `text.ts`'s `norm` — which is free to change, on purpose — this test is the one that
 * has to go red, or a legacy bullet already carried across re-proposes itself as a fresh
 * candidate with nothing else failing anywhere. See the function's own docstring.
 *
 * Every non-ASCII input below is written as \u escapes rather than literal glyphs, per this
 * repo's "no Cyrillic in code" rule and to make the NFC/NFD distinction unambiguous — a
 * literal accented character typed into a source file can silently normalize to either form
 * depending on the editor, which would defeat the point of that test case.
 */
describe("legacyIdemKeyNorm pins the uniq_mcand_idem key format", () => {
  it("case-folds, trims, and collapses internal whitespace, and nothing more", () => {
    expect(legacyIdemKeyNorm("  Loves   Coffee  ")).toBe("loves coffee");
  });

  it("does not fold an apostrophe or touch its casing", () => {
    expect(legacyIdemKeyNorm("Client's Name Is O'Malley")).toBe("client's name is o'malley");
  });

  it("does not apply Unicode NFC — a decomposed and a composed form stay distinct keys", () => {
    // "cafe" + combining acute accent U+0301 (NFD, two code points) vs. "caf" + the single
    // precomposed "e with acute" U+00E9 (NFC, one code point). A future `norm` that
    // NFC-normalizes would collapse these two into one key; this function must not.
    const nfd = "café";
    const nfc = "café";
    expect(legacyIdemKeyNorm(nfd)).toBe(nfd.toLowerCase());
    expect(legacyIdemKeyNorm(nfc)).toBe(nfc.toLowerCase());
    expect(legacyIdemKeyNorm(nfd)).not.toBe(legacyIdemKeyNorm(nfc));
  });

  it("case-folds a non-Latin script (Cyrillic) the same way as any other", () => {
    // Ukrainian "  \u041B\u044E\u0431\u0438\u0442\u044C  \u043A\u0430\u0432\u0443  "
    // ("Loves  coffee", doubled internal space), spelled letter-by-letter as \u escapes so
    // the source file itself carries no Cyrillic code points.
    const input = "  \u041B\u044E\u0431\u0438\u0442\u044C  \u043A\u0430\u0432\u0443  ";
    const expected = "\u043B\u044E\u0431\u0438\u0442\u044C \u043A\u0430\u0432\u0443";
    expect(legacyIdemKeyNorm(input)).toBe(expected);
  });
});
