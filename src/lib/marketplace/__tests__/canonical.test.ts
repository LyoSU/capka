import { describe, it, expect } from "vitest";
import { canonicalTypedValue, contentHash, rootHash, normalizeEndpoint } from "../canonical";
import { fingerprint } from "@/lib/crypto";

const KEY = "a".repeat(64);

describe("canonicalTypedValue", () => {
  it("length-prefixes composites so two different splits cannot collide", () => {
    // Plain concatenation would make ["a","bc"] and ["ab","c"] the same bytes, and a
    // fingerprint that cannot tell them apart cannot detect an argument boundary move.
    expect(canonicalTypedValue("args", ["a", "bc"])).not.toBe(canonicalTypedValue("args", ["ab", "c"]));
  });

  it("puts the field path in the value, so the same secret in two places differs", () => {
    // Otherwise a fingerprint computed for args[0] would be interchangeable with the
    // one for env.TOKEN, and a moved value would read as unchanged.
    expect(canonicalTypedValue("connector.args[0]", "t")).not.toBe(canonicalTypedValue("connector.env.TOKEN", "t"));
  });

  it("distinguishes types that stringify the same", () => {
    expect(canonicalTypedValue("v", "1")).not.toBe(canonicalTypedValue("v", 1));
    expect(canonicalTypedValue("v", null)).not.toBe(canonicalTypedValue("v", "null"));
    expect(canonicalTypedValue("v", undefined)).not.toBe(canonicalTypedValue("v", null));
  });

  it("distinguishes a one-element array from the element itself", () => {
    expect(canonicalTypedValue("v", ["a"])).not.toBe(canonicalTypedValue("v", "a"));
  });

  it("is stable under object key order but not under array order", () => {
    // Object keys are a set; argv is a sequence. Sorting argv would hide a reordering
    // that changes what the command does.
    expect(canonicalTypedValue("e", { b: "2", a: "1" })).toBe(canonicalTypedValue("e", { a: "1", b: "2" }));
    expect(canonicalTypedValue("a", ["x", "y"])).not.toBe(canonicalTypedValue("a", ["y", "x"]));
  });

  it("describes a whole command line in one value", () => {
    const a = canonicalTypedValue("execution", { command: "npx", args: ["-y", "srv"] });
    const b = canonicalTypedValue("execution", { command: "npx", args: ["-y", "srv2"] });
    expect(a).not.toBe(b);
    expect(a).toBe(canonicalTypedValue("execution", { args: ["-y", "srv"], command: "npx" }));
  });
});

describe("fingerprint", () => {
  it("is keyed, so a low-entropy value cannot be recovered by brute force", () => {
    // A plain digest of "TOKEN=abc" is guessable from a wordlist; an HMAC under the
    // instance master key is not, which is why the stored surface may carry it at all.
    const other = "b".repeat(64);
    expect(fingerprint("v", KEY)).not.toBe(fingerprint("v", other));
  });

  it("separates its domain from every other HMAC use of the master key", async () => {
    // The key is derived, not used directly: sandbox/client.ts already HMACs with the
    // same master key, and two features sharing one key must not produce comparable
    // digests.
    const { createHmac } = await import("node:crypto");
    const direct = createHmac("sha256", Buffer.from(KEY, "hex")).update("v").digest("hex");
    expect(fingerprint("v", KEY)).not.toBe(direct);
  });

  it("is deterministic for one key and value", () => {
    expect(fingerprint("v", KEY)).toBe(fingerprint("v", KEY));
  });
});

describe("contentHash", () => {
  it("hashes raw bytes with no normalization at all", () => {
    // A whitespace-only edit MUST read as a change: normalizing is itself an attack
    // surface (zero-width characters, homoglyphs), and in a consent feature a false
    // positive costs a re-review while a false negative hides a modification.
    expect(contentHash("a b")).not.toBe(contentHash("a  b"));
    expect(contentHash("x\n")).not.toBe(contentHash("x\r\n"));
    expect(contentHash("ab")).not.toBe(contentHash("a​b"));
  });
});

describe("rootHash", () => {
  it("is order-independent but path-bound", () => {
    const a = rootHash([{ path: "a.txt", contentHash: "h1" }, { path: "b.txt", contentHash: "h2" }]);
    const b = rootHash([{ path: "b.txt", contentHash: "h2" }, { path: "a.txt", contentHash: "h1" }]);
    expect(a).toBe(b);
    // Same bytes at different paths is a different tree: a file moved into place is a
    // change even when nothing about its contents is.
    const moved = rootHash([{ path: "a.txt", contentHash: "h2" }, { path: "b.txt", contentHash: "h1" }]);
    expect(moved).not.toBe(a);
  });

  it("detects a same-size content swap between two files", () => {
    const before = rootHash([{ path: "run.sh", contentHash: contentHash("aaa") }]);
    const after = rootHash([{ path: "run.sh", contentHash: contentHash("bbb") }]);
    expect(after).not.toBe(before);
  });

  it("distinguishes an empty tree from a missing one", () => {
    expect(rootHash([])).toBe(rootHash([]));
    expect(rootHash([])).not.toBe(contentHash(""));
  });
});

describe("normalizeEndpoint", () => {
  it("fills in the effective port so https://h and https://h:443 read as one endpoint", () => {
    expect(normalizeEndpoint("https://Api.Example.COM/mcp")).toEqual({
      scheme: "https", host: "api.example.com", port: 443, pathname: "/mcp", queryKeys: [],
    });
    expect(normalizeEndpoint("https://api.example.com:443/mcp")).toEqual(
      normalizeEndpoint("https://api.example.com/mcp"));
    expect(normalizeEndpoint("http://api.example.com/mcp")?.port).toBe(80);
  });

  it("keeps query KEYS, sorted, and never their values", () => {
    const e = normalizeEndpoint("https://h.example/mcp?z=secret&a=1&a=2");
    expect(e?.queryKeys).toEqual(["a", "z"]);
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("drops a trailing slash so /mcp and /mcp/ do not read as a path change", () => {
    expect(normalizeEndpoint("https://h.example/mcp/")?.pathname).toBe("/mcp");
    // A bare root has no path to trim; it must not collapse to the empty string.
    expect(normalizeEndpoint("https://h.example/")?.pathname).toBe("/");
  });

  it("never carries URL credentials", () => {
    // A userinfo component is a secret in the URL, and the endpoint is shown to the
    // client. It must be absent from the normalized form, not merely unrendered.
    const e = normalizeEndpoint("https://user:pw@h.example/mcp");
    expect(JSON.stringify(e)).not.toContain("pw");
    expect(JSON.stringify(e)).not.toContain("user");
  });

  it("returns null for a URL it cannot parse rather than inventing an endpoint", () => {
    expect(normalizeEndpoint("not a url")).toBeNull();
  });
});
