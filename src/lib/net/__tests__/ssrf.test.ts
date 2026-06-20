import { describe, it, expect, vi, afterEach } from "vitest";
import { isBlockedAddress, createGuardedFetch } from "../ssrf";

// IP literals resolve to themselves; named hosts resolve to a public IP.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: /^[\d.]+$/.test(host) ? host : "93.184.216.34" }]),
}));

describe("isBlockedAddress", () => {
  it("always blocks link-local / cloud metadata", () => {
    expect(isBlockedAddress("169.254.169.254", false)).toBe(true);
    expect(isBlockedAddress("fe80::1", false)).toBe(true);
  });
  it("allows private ranges unless blockPrivate", () => {
    expect(isBlockedAddress("10.0.0.1", false)).toBe(false);
    expect(isBlockedAddress("10.0.0.1", true)).toBe(true);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(true);
  });
  it("allows public addresses", () => {
    expect(isBlockedAddress("1.1.1.1", true)).toBe(false);
  });
});

describe("createGuardedFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("refuses to follow a redirect to cloud metadata", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    ) as never;
    const guarded = createGuardedFetch({ blockPrivate: false });
    await expect(guarded("https://api.example.com/mcp")).rejects.toThrow(/isn't allowed/i);
  });

  it("aborts a hung request once timeoutMs elapses", async () => {
    // Mimic a provider that accepts the connection but never answers: resolve only
    // if the caller's abort signal fires. Without timeoutMs this would hang forever.
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    ) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, timeoutMs: 20 });
    await expect(guarded("https://api.example.com/mcp")).rejects.toThrow();
  });

  it("follows a safe redirect and injects headers", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://api.example.com/v2/mcp" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, headers: { Authorization: "Bearer t" } });
    const res = await guarded("https://api.example.com/mcp");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.example.com/v2/mcp");
    expect(calls[1].auth).toBe("Bearer t");
  });
});
