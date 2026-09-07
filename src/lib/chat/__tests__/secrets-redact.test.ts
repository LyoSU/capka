import { describe, it, expect } from "vitest";
import {
  normalizeSecretName,
  isValidSecretValue,
  redactSecrets,
  secretEncodings,
  MIN_SECRET_VALUE_CHARS,
  MIN_ENCODED_FORM_CHARS,
} from "@/lib/chat/secrets";

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
  it("takes any value from the redactor's floor up to the cap, but never a NUL", () => {
    expect(isValidSecretValue("sk-live-1")).toBe(true);
    expect(isValidSecretValue("")).toBe(false);
    expect(isValidSecretValue("x".repeat(8192))).toBe(true);
    expect(isValidSecretValue("x".repeat(8193))).toBe(false);
    // A NUL cannot survive an environment variable — it would truncate the value
    // in the container and store a credential that silently isn't the one saved.
    expect(isValidSecretValue("ab\0cd")).toBe(false);
  });

  it("refuses exactly what the redactor would skip", () => {
    // The two floors are ONE constant. Storing a value the redactor ignores would have
    // kept the credential out of the container's env and put it straight into the
    // transcript — the promise printed above the field, broken by the API accepting it.
    expect(MIN_SECRET_VALUE_CHARS).toBeGreaterThan(0);
    expect(isValidSecretValue("x".repeat(MIN_SECRET_VALUE_CHARS - 1))).toBe(false);
    expect(isValidSecretValue("x".repeat(MIN_SECRET_VALUE_CHARS))).toBe(true);
    // The concrete cases from the reports: `KEY=abc` was accepted and never redacted, and
    // `KEY=abcd` was accepted while its unpadded base64 `YWJjZA` went out in the clear.
    expect(isValidSecretValue("abc")).toBe(false);
    expect(isValidSecretValue("abcd")).toBe(false);
  });

  it("refuses a value that is not well-formed UTF-16", () => {
    // Only reachable from a hand-written JSON body. `encodeURIComponent` throws on a lone
    // surrogate, and the redactor runs on every tool result — so one such row used to
    // fail every command in the chat AND in its project siblings, after the command had
    // already run its side effects.
    expect(isValidSecretValue("\ud800abc")).toBe(false);
    expect(isValidSecretValue("\udc00abcd")).toBe(false);
    // A COMPLETE pair is ordinary text and stays storable — an emoji in a passphrase.
    expect(isValidSecretValue("pass\u{1f600}word")).toBe(true);
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

  it("leaves values below the floor alone", () => {
    // A two-character secret matches ordinary prose everywhere; redacting it would
    // shred the output the model has to read while protecting nothing. Unreachable
    // through the API now — `isValidSecretValue` refuses to store one — but a row saved
    // before that gate existed still flows through here.
    expect(redactSecrets("an ab cd result", { SHORT: "ab" })).toBe("an ab cd result");
    expect(redactSecrets("an abcd result", { LEGACY: "abcd" })).toBe("an abcd result");
    expect(redactSecrets("an abcdef result", { OK: "abcdef" })).toBe("an [secret:OK] result");
  });

  it("redacts the encodings a command can produce, not only the literal", () => {
    // `printf %s "$KEY" | base64` was a complete bypass: the literal never appeared, and
    // the model decodes the output itself. Every form below is a one-liner in the sandbox.
    const value = "sk-live-abcdef";
    const env = { TOKEN: value };
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const hex = Buffer.from(value, "utf8").toString("hex");

    expect(redactSecrets(`out=${b64}`, env)).toBe("out=[secret:TOKEN]");
    expect(redactSecrets(`out=${b64.replace(/=+$/, "")}`, env)).toBe("out=[secret:TOKEN]");
    expect(redactSecrets(`out=${hex}`, env)).toBe("out=[secret:TOKEN]");
    expect(redactSecrets(`out=${hex.toUpperCase()}`, env)).toBe("out=[secret:TOKEN]");
  });

  it("redacts url-safe base64 and percent-encoding, which differ only for some values", () => {
    // A value whose base64 carries `+` and `/` is the only one where the url-safe
    // alphabet differs — `base64 | tr '+/' '-_'` and `jq -r @base64d` both show up in
    // real command output, so both alphabets have to be covered.
    const value = "a?b>c~d/+";
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_");
    expect(urlSafe).not.toBe(b64);
    expect(redactSecrets(`x ${b64} y`, { K: value })).toBe("x [secret:K] y");
    expect(redactSecrets(`x ${urlSafe} y`, { K: value })).toBe("x [secret:K] y");
    expect(redactSecrets(`x ${urlSafe.replace(/=+$/, "")} y`, { K: value })).toBe("x [secret:K] y");
    // curl -G --data-urlencode, or any URL the token was pasted into.
    const pct = encodeURIComponent(value);
    expect(pct).not.toBe(value);
    expect(redactSecrets(`https://x/?k=${pct}`, { K: value })).toBe("https://x/?k=[secret:K]");
  });

  it("orders every form longest-first, so a padded encoding cannot half-leak", () => {
    // Unpadded base64 is a PREFIX of the padded form. Replacing the short one first
    // would leave a bare `==` where a credential had been — which reads as redacted and
    // tells the reader the padded form was matched, when it was not.
    const value = "sk-live-abcde";
    const b64 = Buffer.from(value, "utf8").toString("base64");
    expect(b64.endsWith("=")).toBe(true);
    expect(redactSecrets(`out=${b64}`, { TOKEN: value })).toBe("out=[secret:TOKEN]");
  });

  it("takes name/value pairs, so two chats' same-named secrets are both redacted", () => {
    // The workspace union is pairs, not a map: chats in one project each hold a `TOKEN`.
    // Keying by name would have kept one value and handed the model the other.
    const pairs: [string, string][] = [
      ["TOKEN", "sk-chat-a-value"],
      ["TOKEN", "sk-chat-b-value"],
    ];
    expect(redactSecrets("a=sk-chat-a-value b=sk-chat-b-value", pairs)).toBe(
      "a=[secret:TOKEN] b=[secret:TOKEN]",
    );
  });

  it("never throws on a value stored before the validator refused it", () => {
    // The row is already in the table; the redactor is the last line and must not be the
    // thing that breaks the turn. The percent-encoded form is simply skipped.
    const env = { BROKEN: "\ud800abcdef" };
    expect(() => redactSecrets("some output", env)).not.toThrow();
    // The literal still redacts — that is the form a shell would echo.
    expect(redactSecrets("v=\ud800abcdef", env)).toBe("v=[secret:BROKEN]");
  });

  it("holds encoded forms to a higher floor than the literal", () => {
    // Six characters of base64 alphabet turn up inside unrelated identifiers and hashes;
    // replacing part of one with `[secret:NAME]` is both wrong and alarming to read. The
    // literal keeps the lower floor because it is the string the user actually pasted.
    expect(MIN_ENCODED_FORM_CHARS).toBeGreaterThan(MIN_SECRET_VALUE_CHARS);
    // A row from before the raw floor rose: its encodings are under the encoded floor,
    // and its literal is under the raw floor, so it contributes nothing at all.
    expect(redactSecrets("id=xYWJjZAq unrelated", { LEGACY: "abcd" })).toBe("id=xYWJjZAq unrelated");
  });

  it("covers EVERY spelling of a value at the raw floor", () => {
    // The invariant `MIN_ENCODED_FORM_CHARS` is derived from: a storable value has no
    // uncovered form. This is the blocker that made the raw floor six — at four,
    // `printf %s "$TOKEN" | base64 | tr -d =` printed a six-character string that walked
    // straight past the encoded floor.
    const value = "a".repeat(MIN_SECRET_VALUE_CHARS);
    expect(isValidSecretValue(value)).toBe(true);
    for (const form of secretEncodings(value)) {
      // Percent-encoding may be the literal itself; that one is covered at the raw floor
      // and deduped inside `redactSecrets`.
      if (form === value) continue;
      expect(form.length).toBeGreaterThanOrEqual(MIN_ENCODED_FORM_CHARS);
    }
    // And it holds for the awkward shapes too, not only for a run of one letter.
    for (const v of ["ab cd!", "\u{1f600}\u{1f600}\u{1f600}", "a?b>c~", "ABCDEF"]) {
      expect(v.length).toBe(MIN_SECRET_VALUE_CHARS);
      for (const form of secretEncodings(v)) {
        if (form === v) continue;
        expect(form.length).toBeGreaterThanOrEqual(MIN_ENCODED_FORM_CHARS);
      }
    }
  });

  it("produces exactly the forms named here, written out rather than derived", () => {
    // Pinned as LITERAL strings on purpose. The invariant test above iterates whatever
    // `secretEncodings` returns, so it would pass just as happily if the function were
    // emptied — it checks a property of the list, not that the list exists. These are the
    // strings a shell actually prints, transcribed by hand.
    const value = "sk-live-a?b>c";
    const expected = [
      "c2stbGl2ZS1hP2I+Yw==", // base64, padded
      "c2stbGl2ZS1hP2I+Yw", //   base64, padding stripped (`| tr -d =`)
      "c2stbGl2ZS1hP2I-Yw==", // url-safe alphabet, padded
      "c2stbGl2ZS1hP2I-Yw", //   url-safe, padding stripped
      "736b2d6c6976652d613f623e63", // hex (xxd -p, sha-style tooling)
      "736B2D6C6976652D613F623E63", // hex, upper (od, some hexdump flavours)
      "sk-live-a%3Fb%3Ec", //   percent-encoded (curl --data-urlencode)
    ];
    // Set equality both ways: a missing form is a leak, and an unexpected one means the
    // list grew without anyone writing down what a command would have to do to produce it.
    expect(new Set(secretEncodings(value))).toEqual(new Set(expected));
    // And each of them actually redacts, which the list alone does not prove.
    for (const form of expected) {
      expect(redactSecrets(`out=${form}`, { TOKEN: value })).toBe("out=[secret:TOKEN]");
    }
  });

  it("redacts column-wrapped base64, which is what the tools print by default", () => {
    // GNU coreutils `base64` wraps at 76 columns and `openssl base64` at 64, so for any
    // value over 57 bytes the output is two lines and an exact-substring redactor looking
    // for the flat string finds nothing. That made `printf %s "$KEY" | base64` a bypass
    // again for exactly the long credentials most worth protecting.
    const value = "K".repeat(60);
    const flat = Buffer.from(value, "utf8").toString("base64");
    expect(flat).toHaveLength(80);

    const gnu = `${flat.slice(0, 76)}\n${flat.slice(76)}`;
    const openssl = `${flat.slice(0, 64)}\n${flat.slice(64)}`;
    expect(redactSecrets(`out=${gnu}\n`, { TOKEN: value })).toBe("out=[secret:TOKEN]\n");
    expect(redactSecrets(`out=${openssl}\n`, { TOKEN: value })).toBe("out=[secret:TOKEN]\n");
    // The flat form stays covered too — a `| tr -d '\\n'` or a 57-byte value produces it.
    expect(redactSecrets(`out=${flat}`, { TOKEN: value })).toBe("out=[secret:TOKEN]");
  });

  it("redacts wrapped base64 with the padding stripped — `base64 | tr -d =` exactly", () => {
    // 61 bytes: base64 is 84 chars ending in "=", so GNU wraps it at 76 AND the padding
    // is there to strip. Wrapping only the padded spelling left this pipeline open.
    const value = "K".repeat(61);
    const padded = Buffer.from(value, "utf8").toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    const stripped = padded.replace(/=+$/, "");
    const piped = `${stripped.slice(0, 76)}\n${stripped.slice(76)}`;
    expect(redactSecrets(`out=${piped}\n`, { TOKEN: value })).toBe("out=[secret:TOKEN]\n");
  });

  it("adds no wrapped form for a value whose base64 fits one line", () => {
    // Otherwise every short secret would carry two useless duplicates of its own base64.
    expect(secretEncodings("sk-live-a?b>c").some((f) => f.includes("\n"))).toBe(false);
  });

  it("redacts the unpadded base64 of a value at the raw floor", () => {
    // The exact bypass, spelled the exact way a shell spells it.
    const value = "abcdef";
    const unpadded = Buffer.from(value, "utf8").toString("base64").replace(/=+$/, "");
    expect(unpadded).toBe("YWJjZGVm");
    expect(redactSecrets(`out=${unpadded}`, { TOKEN: value })).toBe("out=[secret:TOKEN]");
    expect(redactSecrets("out=616263646566", { TOKEN: value })).toBe("out=[secret:TOKEN]");
  });

  it("is a no-op with no secrets and on empty text", () => {
    expect(redactSecrets("plain output", {})).toBe("plain output");
    expect(redactSecrets("", { TOKEN: "sk-live-abcdef" })).toBe("");
    expect(redactSecrets("plain output", [])).toBe("plain output");
  });
});
