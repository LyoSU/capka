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

  it("trusts a live session's owner when no userId is supplied", () => {
    expect(resolveOwnerDecision({ session, sessionId: "s1", secret: SECRET }))
      .toEqual({ userId: "alice", sessionId: "s1" });
  });

  it("resolves to the session OWNER even when another (authorized) user asks", () => {
    // Shared project folder: a project member browses the session owner's workspace.
    // Per-user authz is the platform's job (requireOwned); the controller trusts it
    // on the live path. So bob asking for alice's project session resolves to alice.
    expect(resolveOwnerDecision({ session, sessionId: "s1", fallbackUserId: "bob", secret: SECRET }))
      .toEqual({ userId: "alice", sessionId: "s1" });
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
