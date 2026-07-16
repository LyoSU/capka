import { describe, it, expect, vi, afterEach } from "vitest";
import { lookup } from "node:dns/promises";
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
  it("always blocks 0.0.0.0 / :: / multicast / broadcast regardless of policy", () => {
    expect(isBlockedAddress("0.0.0.0", false)).toBe(true);
    expect(isBlockedAddress("::", false)).toBe(true);
    expect(isBlockedAddress("224.0.0.1", false)).toBe(true); // multicast
    expect(isBlockedAddress("239.255.255.250", false)).toBe(true); // SSDP multicast
    expect(isBlockedAddress("255.255.255.255", false)).toBe(true); // broadcast
    expect(isBlockedAddress("ff02::1", false)).toBe(true); // v6 multicast
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

  it("pins the connection to the vetted IP (closes the DNS-rebind window)", async () => {
    // Real fetch so the pinned undici dispatcher is actually honored (the other
    // tests stub globalThis.fetch, which ignores the dispatcher).
    globalThis.fetch = realFetch;
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      // DNS says this hostname is 127.0.0.1 (our server). The guard vets it
      // (blockPrivate=false allows loopback) and must connect THERE — with the Host
      // header still the hostname, proving the connection used the vetted IP rather
      // than re-resolving at connect time (where a rebind could swap in a bad IP).
      vi.mocked(lookup).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
      const guarded = createGuardedFetch({ blockPrivate: false });
      const res = await guarded(`http://vetted.example:${port}/`);
      const body = (await res.json()) as { host: string };
      expect(res.status).toBe(200);
      expect(body.host).toBe(`vetted.example:${port}`);
      // The request-scoped Agent must retire after its body is consumed. Without
      // close(), undici keeps this socket/pool alive and repeated provider calls
      // accumulate external memory even though JS heap stays flat.
      await expect.poll(
        () => new Promise<number>((resolve) => server.getConnections((_err, count) => resolve(count))),
      ).toBe(0);
    } finally {
      server.close();
    }
  });

  it("strips credentials on a cross-host redirect (no token leak to a different host)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      // api.github.com → a different host (mimics raw/codeload → object storage).
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://objstore.example.net/blob" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, headers: { Authorization: "Bearer ghtoken" } });
    const res = await guarded("https://api.github.com/repos/x/y/contents/z");
    expect(res.status).toBe(200);
    expect(calls[0].auth).toBe("Bearer ghtoken"); // sent to the original host
    expect(calls[1].auth).toBeNull(); // NOT forwarded to the cross-host redirect target
  });
});
