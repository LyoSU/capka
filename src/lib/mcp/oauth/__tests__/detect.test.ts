import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectAuthKind } from "../detect";

// detect runs through the SSRF-guarded fetch, which resolves DNS via
// node:dns/promises — stub it to a public IP so the guard passes for test hosts.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34" }]) }));
// blockPrivate policy reads a DB setting — force it off for the unit test.
vi.mock("@/lib/settings", () => ({ getBlockPrivateProviderUrls: vi.fn(async () => false) }));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.clearAllMocks(); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AS_METADATA = {
  issuer: "https://mcp.x/",
  authorization_endpoint: "https://mcp.x/authorize",
  token_endpoint: "https://mcp.x/token",
  response_types_supported: ["code"],
};

/** Route a fake fetch by pathname so we can model real discovery shapes. */
function route(handler: (path: string) => Response) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
    return handler(path);
  }) as never;
}

describe("detectAuthKind", () => {
  it("returns 'oauth' via RFC 9728 protected-resource metadata", async () => {
    route((path) =>
      path.startsWith("/.well-known/oauth-protected-resource")
        ? json({ resource: "https://mcp.x/", authorization_servers: ["https://mcp.x/"] })
        : path.startsWith("/.well-known/oauth-authorization-server")
          ? json(AS_METADATA)
          : json("nope", 404),
    );
    expect(await detectAuthKind("https://mcp.x/mcp")).toBe("oauth");
  });

  it("returns 'oauth' when only RFC 8414 authorization-server metadata exists (no RFC 9728)", async () => {
    // Regression: providers like the grok MCP 404 on protected-resource but expose
    // /.well-known/oauth-authorization-server at the root. Must not fall back to 'token'.
    route((path) =>
      path === "/.well-known/oauth-authorization-server" ? json(AS_METADATA) : json("nope", 404),
    );
    expect(await detectAuthKind("https://mcp.x/mcp")).toBe("oauth");
  });

  it("returns 'token' when there is no OAuth metadata anywhere", async () => {
    route(() => json("nope", 404));
    expect(await detectAuthKind("https://mcp.x/mcp")).toBe("token");
  });
});
