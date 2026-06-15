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

describe("detectAuthKind", () => {
  it("returns 'oauth' when the server advertises protected-resource metadata", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ resource: "https://mcp.x/", authorization_servers: ["https://auth.x/"] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    ) as never;
    expect(await detectAuthKind("https://mcp.x/mcp")).toBe("oauth");
  });

  it("returns 'token' when there is no OAuth metadata (404 / unreachable)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as never;
    expect(await detectAuthKind("https://mcp.x/mcp")).toBe("token");
  });
});
