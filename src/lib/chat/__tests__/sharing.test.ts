import { describe, it, expect } from "vitest";
import { resolveShareAccess, isShared, generateShareToken } from "../sharing";

describe("resolveShareAccess", () => {
  it("treats a private chat as non-existent regardless of session", () => {
    expect(resolveShareAccess("private", false)).toBe("not-found");
    expect(resolveShareAccess("private", true)).toBe("not-found");
  });

  it("opens a link-shared chat to anyone, signed in or not", () => {
    expect(resolveShareAccess("link", false)).toBe("ok");
    expect(resolveShareAccess("link", true)).toBe("ok");
  });

  it("gates a users-shared chat behind a session", () => {
    expect(resolveShareAccess("users", false)).toBe("needs-auth");
    expect(resolveShareAccess("users", true)).toBe("ok");
  });

  it("defaults an unknown visibility to not-found (never leaks existence)", () => {
    expect(resolveShareAccess("", false)).toBe("not-found");
    expect(resolveShareAccess("bogus", true)).toBe("not-found");
  });
});

describe("isShared", () => {
  it("is true only for link and users", () => {
    expect(isShared("private")).toBe(false);
    expect(isShared("link")).toBe(true);
    expect(isShared("users")).toBe(true);
    expect(isShared("nonsense")).toBe(false);
  });
});

describe("generateShareToken", () => {
  it("produces distinct, URL-safe, sufficiently long handles", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
