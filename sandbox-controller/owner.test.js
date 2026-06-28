import { describe, it, expect } from "vitest";
import { resolveOwnerDecision, workspaceToken, safeEqual } from "./owner.js";

const SECRET = "test-secret";

describe("safeEqual", () => {
  it("is true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // length mismatch, no throw
  });
});

describe("resolveOwnerDecision", () => {
  const session = { sessionId: "s1", userId: "alice" };

  it("reports missing when no userId is supplied, even for a live session", () => {
    // A live session no longer skips auth: every op must carry a userId + token.
    expect(resolveOwnerDecision({ session, sessionId: "s1", secret: SECRET }))
      .toEqual({ missing: true });
  });

  it("allows a live session's OWNER with a valid token", () => {
    const token = workspaceToken(SECRET, "alice", "s1");
    expect(resolveOwnerDecision({ session, sessionId: "s1", fallbackUserId: "alice", token, secret: SECRET }))
      .toEqual({ userId: "alice", sessionId: "s1" });
  });

  it("forbids a live session with no token, even from the owner", () => {
    expect(resolveOwnerDecision({ session, sessionId: "s1", fallbackUserId: "alice", secret: SECRET }))
      .toEqual({ forbidden: true });
  });

  it("forbids a different user on a live session even with a token valid for THEM", () => {
    // bob holds a token bound to (bob, s1) — valid HMAC — but the live session is
    // owned by alice. A token minted for another user must never reach her files.
    const token = workspaceToken(SECRET, "bob", "s1");
    expect(resolveOwnerDecision({ session, sessionId: "s1", fallbackUserId: "bob", token, secret: SECRET }))
      .toEqual({ forbidden: true });
  });

  it("reports missing when no session and no userId", () => {
    expect(resolveOwnerDecision({ session: null, sessionId: "s1", secret: SECRET }))
      .toEqual({ missing: true });
  });

  it("forbids no-session access without a valid token", () => {
    expect(resolveOwnerDecision({ session: null, sessionId: "s1", fallbackUserId: "bob", token: "nope", secret: SECRET }))
      .toEqual({ forbidden: true });
  });

  it("allows no-session access with a valid HMAC token bound to the user", () => {
    const token = workspaceToken(SECRET, "bob", "s1");
    expect(resolveOwnerDecision({ session: null, sessionId: "s1", fallbackUserId: "bob", token, secret: SECRET }))
      .toEqual({ userId: "bob", sessionId: "s1" });
  });

  it("rejects a token minted for a different session (binding is enforced)", () => {
    const token = workspaceToken(SECRET, "bob", "OTHER");
    expect(resolveOwnerDecision({ session: null, sessionId: "s1", fallbackUserId: "bob", token, secret: SECRET }))
      .toEqual({ forbidden: true });
  });
});
