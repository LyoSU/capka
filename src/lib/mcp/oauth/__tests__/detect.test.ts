import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectAuthKind } from "../detect";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
beforeEach(() => { vi.restoreAllMocks(); });

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
