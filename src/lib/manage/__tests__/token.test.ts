import { describe, it, expect } from "vitest";
import { signToken, verifyToken, hashArgs } from "../token";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("manage/token", () => {
  it("round-trips a confirm payload through sign → verify", () => {
    const payload = { purpose: "confirm" as const, controlId: "org.sandbox_network", argsHash: "abc", userId: "u1" };
    const token = signToken(payload, SECRET);
    const res = verifyToken(token, SECRET);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual(payload);
  });

  it("rejects a tampered payload as bad_signature", () => {
    const token = signToken({ purpose: "confirm", controlId: "org.x", argsHash: "a", userId: "u1" }, SECRET);
    const [body, sig] = token.split(".");
    // Flip one char in the body without re-signing.
    const tampered = `${body.slice(0, -1)}${body.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    const res = verifyToken(tampered, SECRET);
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken({ purpose: "undo", controlId: "user.locale", prev: "en", userId: "u1" }, SECRET);
    const res = verifyToken(token, "ffffffffffffffffffffffffffffffff");
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token", () => {
    const t0 = 1_000_000;
    const token = signToken({ purpose: "confirm", controlId: "org.x", argsHash: "a", userId: "u1" }, SECRET, {
      ttlMs: 60_000,
      now: t0,
    });
    const res = verifyToken(token, SECRET, t0 + 60_001);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a token still within its TTL", () => {
    const t0 = 1_000_000;
    const token = signToken({ purpose: "confirm", controlId: "org.x", argsHash: "a", userId: "u1" }, SECRET, {
      ttlMs: 60_000,
      now: t0,
    });
    expect(verifyToken(token, SECRET, t0 + 59_000).ok).toBe(true);
  });

  it("reports a structurally malformed token", () => {
    expect(verifyToken("not-a-token", SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("hashArgs is stable regardless of key order", () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});
