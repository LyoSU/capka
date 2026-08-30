import { describe, it, expect } from "vitest";
import { looksLikeSecret, secretShaped } from "@/lib/vault/claims";

/**
 * The screen on its own, and — as of the authority cutover — a screen whose LIMITS are
 * asserted as deliberately as its coverage.
 *
 * What it is now: an advisory flag on a row a person reads before deciding whether the
 * model may see it. It is no longer a security boundary, because the boundary moved to
 * the confirmation itself. That is what makes an incomplete heuristic acceptable here,
 * and it is why the "known limits" block below asserts `false` rather than being left
 * unwritten. Those rows are the record that nobody forgot: a change that makes one of
 * them pass has to come here and say why, which is the whole point of writing a limit
 * down instead of implying coverage.
 *
 * What was removed, and must not come back as a word list: an assignment pattern for
 * `password|secret|token|api_key|authorization`, and prefix patterns for four vendors.
 * The first spoke English only, in a Ukrainian-first product; the second enumerated the
 * vendors somebody happened to think of. Both look like coverage and are absent exactly
 * where nobody enumerated. What remains generalises by SHAPE, so it says the same thing
 * in every language and for every vendor.
 */
describe("looksLikeSecret — a long opaque run, in any language", () => {
  it.each([
    ["a 40-char hex commit-sized blob", "the deploy token is 0123456789abcdef0123456789abcdef01234567"],
    ["a bare base64 token", "auth is dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgdmFsdWU="],
    ["a full-length OpenAI project key", "my key is sk-proj-AbCdEf0123456789ghijklMnOpQrStUvWxYz0123456789"],
    // The screen never reads vocabulary, so the language of the sentence around the run
    // cannot change its answer. This row is the universality claim, asserted.
    ["the same run inside a non-English sentence", "ключ: 0123456789abcdef0123456789abcdef01234567"],
    ["a GitHub fine-grained PAT body", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789"],
  ])("screens %s", (_name, statement) => {
    expect(looksLikeSecret(statement)).toBe(true);
  });

  it.each([
    ["an ordinary fact", "pays suppliers in EUR"],
    ["a URL with a long hyphenated slug", "The user prefers the article at https://example.com/how-to-configure-the-thing-properly"],
    ["a preview-deploy hostname", "Staging lives at deploy-preview-1234-my-app-name.netlify.app"],
    ["a UUID", "Project id is 3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
  ])("leaves %s alone", (_name, statement) => {
    expect(looksLikeSecret(statement)).toBe(false);
  });

  /**
   * KNOWN LIMITS, asserted so they stay known. Every row here is a credential this
   * screen does NOT flag, and each was caught by the deleted word list. They are
   * acceptable because the person sees the statement before the model ever can — and
   * they are written here so that "the screen catches credentials" is never believed
   * further than it is true.
   */
  it.each([
    ["an English credential assignment", 'the config line is password: "hunter22"'],
    ["the same sentence in Ukrainian — the gap that started this", "пароль від пошти: hunter22"],
    ["a short vendor-prefixed token", "token ghp_ABCdef1234567890abcd"],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a connection string with a short password", "our db is postgresql://svcuser:Sup3rPW9@db.internal:5432/prod"],
  ])("does NOT flag %s, and that is the documented cost", (_name, statement) => {
    expect(looksLikeSecret(statement)).toBe(false);
  });
});

/**
 * H3 — the size cap must not be an evasion gadget.
 *
 * `fitStatement` keeps 500 characters and `fitSlotKey` 120. A statement whose opaque run
 * straddles that boundary matches RAW and stops matching once stored, so screening the
 * stored form alone wrote it non-sensitive and put it in front of the model with the
 * missing character recoverable in a few dozen guesses. Screening the raw form alone is
 * the mirror error — it would hide the wrong string. So: the OR of both, and these cases
 * are what fails if either half is dropped.
 */
describe("secretShaped reads the raw text and the stored text", () => {
  // 501 characters, the last 28 of which are the token. One character falls off.
  const straddlingStatement = "note ".repeat(94) + "xx " + "1234567890abcdefghijklmnopqr";
  // 121 characters of slot key. Every leading segment is short enough to be ordinary
  // path text (the screen reads a key per segment, so a long KEY is not a long run);
  // only the last segment is opaque, and it is exactly at the floor, so losing one
  // character to the cap takes it below.
  const straddlingSlot = "x".repeat(20) + ["/" + "x".repeat(20)].join("").repeat(3) + "/" + "x".repeat(8) + "/" + "b".repeat(28);

  it("flags a statement whose run is cut by the 500-character cap", () => {
    expect(straddlingStatement.length).toBe(501);
    // The control that makes the case real rather than assumed: the STORED form is
    // genuinely clean, so a screen reading only that answers `false` here.
    expect(looksLikeSecret(straddlingStatement.slice(0, 500))).toBe(false);
    expect(looksLikeSecret(straddlingStatement)).toBe(true);
    expect(secretShaped(straddlingStatement, undefined, undefined)).toBe(true);
  });

  it("flags a slot key whose run is cut by the 120-character cap", () => {
    expect(straddlingSlot.length).toBe(121);
    expect(secretShaped("an ordinary sentence", straddlingSlot.slice(0, 120), undefined)).toBe(false);
    expect(secretShaped("an ordinary sentence", straddlingSlot, undefined)).toBe(true);
  });

  it("flags a run in a structured value", () => {
    expect(secretShaped("ordinary", undefined, { token: "0123456789abcdef0123456789abcdef" })).toBe(true);
    expect(secretShaped("ordinary", undefined, { days: 30 })).toBe(false);
  });

  it("does not fire on an ordinary deep slot key", () => {
    // The systematic false positive this screen was reshaped to avoid: `/` and `_` are in
    // the run's character class, so a whole key would otherwise be one long match.
    expect(secretShaped("Acme pays in 30 days", "suppliers/acme_corp/payment_terms", undefined)).toBe(false);
  });
});
