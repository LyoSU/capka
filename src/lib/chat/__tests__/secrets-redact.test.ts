import { describe, it, expect } from "vitest";
import { normalizeSecretName, isValidSecretValue, redactSecrets } from "@/lib/chat/secrets";

describe("normalizeSecretName", () => {
  it("turns what a person types into an environment variable name", () => {
    expect(normalizeSecretName("stripe key")).toBe("STRIPE_KEY");
    expect(normalizeSecretName("  My-API  Token! ")).toBe("MY_API_TOKEN");
    expect(normalizeSecretName("token")).toBe("TOKEN");
    // A run of junk collapses to ONE underscore, and the edges are trimmed — the
    // alternative reads as a typo the user cannot see themselves having made.
    expect(normalizeSecretName("a...b")).toBe("A_B");
    expect(normalizeSecretName("_token_")).toBe("TOKEN");
  });

  it("rejects what cannot be a variable name", () => {
    expect(normalizeSecretName("")).toBeNull();
    expect(normalizeSecretName("   ")).toBeNull();
    expect(normalizeSecretName("!!!")).toBeNull();
    // Leading digit: `$1PASSWORD` is not a reference to anything, so there is no
    // correct normalisation and guessing one would store a variable that never resolves.
    expect(normalizeSecretName("1password")).toBeNull();
    expect(normalizeSecretName("a".repeat(65))).toBeNull();
    expect(normalizeSecretName("a".repeat(64))).toBe("A".repeat(64));
  });
});

describe("isValidSecretValue", () => {
  it("takes any non-empty value up to the cap, but never a NUL", () => {
    expect(isValidSecretValue("sk-live-1")).toBe(true);
    expect(isValidSecretValue("")).toBe(false);
    expect(isValidSecretValue("x".repeat(8192))).toBe(true);
    expect(isValidSecretValue("x".repeat(8193))).toBe(false);
    // A NUL cannot survive an environment variable — it would truncate the value
    // in the container and store a credential that silently isn't the one saved.
    expect(isValidSecretValue("ab\0cd")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence, in whichever string it is handed", () => {
    const env = { TOKEN: "sk-live-abcdef" };
    expect(redactSecrets("using sk-live-abcdef twice: sk-live-abcdef", env)).toBe(
      "using [secret:TOKEN] twice: [secret:TOKEN]",
    );
    // stdout and stderr are two calls to this one function, so the same input
    // redacts identically whichever stream it arrived on.
    expect(redactSecrets("curl: bad key sk-live-abcdef", env)).toBe("curl: bad key [secret:TOKEN]");
  });

  it("redacts the LONGEST value first so an overlapping pair cannot half-leak", () => {
    // BASE is a prefix of FULL. Shortest-first would rewrite the prefix and leave
    // "-suffix" sitting in the transcript — half a credential is still a leak.
    const env = { BASE: "sk-live-abcd", FULL: "sk-live-abcd-suffix" };
    expect(redactSecrets("value=sk-live-abcd-suffix", env)).toBe("value=[secret:FULL]");
    expect(redactSecrets("value=sk-live-abcd", env)).toBe("value=[secret:BASE]");
  });

  it("leaves values shorter than four characters alone", () => {
    // A two-character secret matches ordinary prose everywhere; redacting it would
    // shred the output the model has to read while protecting nothing.
    expect(redactSecrets("an ab cd result", { SHORT: "ab" })).toBe("an ab cd result");
    expect(redactSecrets("an abcd result", { OK: "abcd" })).toBe("an [secret:OK] result");
  });

  it("is a no-op with no secrets and on empty text", () => {
    expect(redactSecrets("plain output", {})).toBe("plain output");
    expect(redactSecrets("", { TOKEN: "sk-live-abcdef" })).toBe("");
  });
});
