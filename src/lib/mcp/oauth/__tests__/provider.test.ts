import { describe, it, expect } from "vitest";
import { McpOAuthProvider, OAUTH_CALLBACK_PATH } from "../provider";

describe("McpOAuthProvider", () => {
  it("runtime mode refuses to redirect (no interactive prompt mid-run)", async () => {
    const p = new McpOAuthProvider("u1", "s1", "runtime");
    await expect(p.redirectToAuthorization(new URL("https://auth.x/authorize"))).rejects.toThrow(/sign-in required/i);
  });

  it("callback mode replays the preset PKCE verifier", () => {
    const p = new McpOAuthProvider("u1", "s1", "callback", "verifier-123");
    expect(p.codeVerifier()).toBe("verifier-123");
  });

  it("advertises the fixed callback redirect URL", () => {
    const p = new McpOAuthProvider("u1", "s1", "flow");
    expect(p.redirectUrl.endsWith(OAUTH_CALLBACK_PATH)).toBe(true);
    expect(p.clientMetadata.redirect_uris[0]).toBe(p.redirectUrl);
  });
});
