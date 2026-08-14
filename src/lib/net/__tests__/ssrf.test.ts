import { describe, it, expect, vi, afterEach } from "vitest";
import { lookup } from "node:dns/promises";
import { isBlockedAddress, createGuardedFetch, assertSafeUrl, preflightUrl, UnsafeUrlError } from "../ssrf";

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

  it("blocks an IPv4 address however it is spelled inside IPv6", () => {
    // The check used to slice the literal prefix "::ffff:" and hand the rest to isIPv4 —
    // which only works for the DOTTED tail. A resolver is free to answer with the hex form,
    // and then metadata and loopback sailed straight through. `new URL()` is no help: it
    // normalizes the safe spelling INTO the unsafe one (`::ffff:169.254.169.254` becomes
    // `::ffff:a9fe:a9fe`), which is why this is decided on bytes.
    expect(isBlockedAddress("::ffff:169.254.169.254", false)).toBe(true);
    expect(isBlockedAddress("::ffff:a9fe:a9fe", false)).toBe(true); // same address, hex
    expect(isBlockedAddress("64:ff9b::a9fe:a9fe", false)).toBe(true); // NAT64 well-known prefix
    expect(isBlockedAddress("::ffff:7f00:1", true)).toBe(true); // 127.0.0.1, mapped
    expect(isBlockedAddress("::7f00:1", true)).toBe(true); // 127.0.0.1, v4-compatible
    expect(isBlockedAddress("::127.0.0.1", true)).toBe(true); // the same, dotted
    // A public address stays reachable through every one of those spellings.
    expect(isBlockedAddress("::ffff:1.1.1.1", true)).toBe(false);
    expect(isBlockedAddress("::ffff:101:101", true)).toBe(false);
  });

  it("blocks loopback and the unspecified address written out in full", () => {
    // Neither matched the old `lower === "::1"` / `lower === "::"` equality tests.
    expect(isBlockedAddress("0:0:0:0:0:0:0:1", true)).toBe(true);
    expect(isBlockedAddress("0:0:0:0:0:0:0:0", false)).toBe(true);
    expect(isBlockedAddress("fe80:0:0:0:0:0:0:1", false)).toBe(true);
  });

  it("refuses an address it cannot parse instead of allowing it", () => {
    // Fail-closed: this decides whether to open a connection, and "unrecognized" is not
    // evidence of safety. These used to fall through to `return false`.
    expect(isBlockedAddress("not-an-address", false)).toBe(true);
    expect(isBlockedAddress("", false)).toBe(true);
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

  it("REFUSES an https → http redirect outright, same host or not", async () => {
    // "Same origin" was compared by host, so a downgrade to the SAME hostname kept the
    // Authorization header, any fixed secret headers, the method and the body — in cleartext.
    // Connection pinning is no help: the bytes are simply no longer encrypted. And stripping
    // credentials would not be enough either, since the method and body still travel.
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "http://api.example.com/mcp" } }),
    ) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, headers: { Authorization: "Bearer t" } });
    await expect(guarded("https://api.example.com/mcp")).rejects.toSatisfy(
      (e) => e instanceof UnsafeUrlError && e.reason === "blocked");
  });

  it("still injects headers on a same-ORIGIN redirect, scheme included", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://api.example.com/v2/mcp" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, headers: { Authorization: "Bearer t" } });
    expect((await guarded("https://api.example.com/mcp")).status).toBe(200);
    expect(calls[1].auth).toBe("Bearer t");
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

  it("drops EVERY caller header cross-origin, not just authorization/cookie", async () => {
    // The strip used to be a two-name blocklist, which missed the header every AI SDK
    // actually authenticates with: a custom Anthropic/Google/Azure base URL hands the key
    // to this fetch in `init.headers`, so one 3xx to an attacker's host leaked it.
    const calls: Record<string, string | null>[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({
        "x-api-key": h.get("x-api-key"),
        "x-goog-api-key": h.get("x-goog-api-key"),
        "api-key": h.get("api-key"),
        "content-type": h.get("content-type"),
      });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://evil.example.net/collect" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false });
    const res = await guarded("https://gateway.example.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-secret", "x-goog-api-key": "goog-secret", "api-key": "azure-secret", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(calls[0]["x-api-key"]).toBe("sk-ant-secret"); // fine — still the origin the admin configured
    expect(calls[1]["x-api-key"]).toBeNull();
    expect(calls[1]["x-goog-api-key"]).toBeNull();
    expect(calls[1]["api-key"]).toBeNull();
    expect(calls[1]["content-type"]).toBe("application/json"); // carries no authority; kept
  });

  it("turns a redirected POST into a GET and drops the body (301/302/303)", async () => {
    // Replaying method+body verbatim re-sent a request the caller aimed at the ORIGINAL
    // host to whatever the redirect names. Only 307/308 are defined to preserve them.
    const calls: { method: string | undefined; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://api.example.com/v2" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false });
    await guarded("https://api.example.com/v1", { method: "POST", body: "secret=1" });
    expect(calls[0]).toMatchObject({ method: "POST", body: "secret=1" });
    expect(calls[1].method).toBe("GET");
    expect(calls[1].body).toBeUndefined();
  });

  it("preserves method and body across a 307", async () => {
    const calls: { method: string | undefined; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body });
      if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "https://api.example.com/v2" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false });
    await guarded("https://api.example.com/v1", { method: "POST", body: "payload" });
    expect(calls[1]).toMatchObject({ method: "POST", body: "payload" });
  });

  it("does NOT re-attach credentials when a chain bounces back to the original origin", async () => {
    // The strip was per-hop, so an attacker-controlled host could 3xx the chain home and
    // get the headers back — on a PATH it chose. Once trust is lost it stays lost.
    const calls: { url: string; auth: string | null; key: string | null }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      calls.push({ url, auth: h.get("authorization"), key: h.get("x-api-key") });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://evil.example.net/bounce" } });
      if (calls.length === 2) return new Response(null, { status: 302, headers: { location: "https://api.github.com/exfil" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false, headers: { Authorization: "Bearer ghtoken" } });
    await guarded("https://api.github.com/repos/x/y", { headers: { "x-api-key": "sk-secret" } });
    expect(calls[0]).toMatchObject({ auth: "Bearer ghtoken", key: "sk-secret" });
    expect(calls[1]).toMatchObject({ auth: null, key: null }); // cross-origin hop
    expect(calls[2]).toMatchObject({ auth: null, key: null }); // back home, still stripped
  });

  it("REFUSES a cross-origin 307/308 that would carry the body", async () => {
    // Stripping headers does nothing here: 307/308 keep the body, and for an MCP token
    // request the body IS the credential (`code` + `client_secret` + `code_verifier`).
    for (const status of [307, 308]) {
      globalThis.fetch = vi.fn(async () =>
        new Response(null, { status, headers: { location: "https://evil.example.net/collect" } })) as never;
      const guarded = createGuardedFetch({ blockPrivate: false });
      await expect(guarded("https://idp.example.com/token", {
        method: "POST", body: "code=abc&client_secret=shhh",
      })).rejects.toSatisfy((e) => e instanceof UnsafeUrlError && e.reason === "blocked");
    }
  });

  it("still follows a cross-origin 307 when there is no body to leak", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      if (calls.length === 1) return new Response(null, { status: 307, headers: { location: "https://cdn.example.net/x" } });
      return new Response("ok", { status: 200 });
    }) as never;
    const guarded = createGuardedFetch({ blockPrivate: false });
    expect((await guarded("https://api.example.com/x")).status).toBe(200);
  });
});

describe("UnsafeUrlError", () => {
  afterEach(() => {
    vi.mocked(lookup).mockImplementation(async (host: string) =>
      [{ address: /^[\d.]+$/.test(host as string) ? (host as string) : "93.184.216.34", family: 4 }] as never);
  });

  it("carries a machine-readable reason while leaving the friendly message intact", async () => {
    // The message is user-facing copy that an editor may reword at any time. A caller
    // classifying on it would flip a SECURITY verdict on a copy edit, so the reason is
    // a separate, typed field — and the message must not change with it, because
    // mcp/service.ts re-wraps `e.message` verbatim as a ValidationError.
    await expect(assertSafeUrl("not-a-url", false)).rejects.toThrow("Invalid URL");
    await expect(assertSafeUrl("ftp://example.com", false)).rejects.toThrow("URL must use http or https");

    for (const [raw, reason] of [["not-a-url", "invalid"], ["ftp://example.com", "invalid"]] as const) {
      await expect(assertSafeUrl(raw, false)).rejects.toSatisfy(
        (e) => e instanceof UnsafeUrlError && e.reason === reason);
    }
  });

  it("distinguishes a host that does not resolve from one that resolves somewhere forbidden", async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(assertSafeUrl("https://gone.example", false)).rejects.toSatisfy(
      (e) => e instanceof UnsafeUrlError && e.reason === "unresolved");

    await expect(assertSafeUrl("http://169.254.169.254/latest/", false)).rejects.toSatisfy(
      (e) => e instanceof UnsafeUrlError && e.reason === "blocked");
  });
});

describe("preflightUrl", () => {
  afterEach(() => {
    vi.mocked(lookup).mockImplementation(async (host: string) =>
      [{ address: /^[\d.]+$/.test(host as string) ? (host as string) : "93.184.216.34", family: 4 }] as never);
  });

  it("returns a verdict instead of throwing, so one bad connector cannot abort a review", async () => {
    expect(await preflightUrl("https://api.example.com/mcp", false)).toBe("allowed");
    expect(await preflightUrl("http://169.254.169.254/", false)).toBe("blocked");
    expect(await preflightUrl("ftp://example.com", false)).toBe("invalid");
    vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await preflightUrl("https://gone.example", false)).toBe("unresolved");
  });

  it("honours the private-range policy, since the same URL is safe on one instance and not another", async () => {
    expect(await preflightUrl("http://10.0.0.5/mcp", false)).toBe("allowed");
    expect(await preflightUrl("http://10.0.0.5/mcp", true)).toBe("blocked");
  });

  it("reports an unexpected failure as blocked, never as allowed", async () => {
    // Fail-closed: a verdict computed for display still decides `cannot_apply`, so an
    // internal error must not read as permission.
    vi.mocked(lookup).mockImplementationOnce((() => { throw new TypeError("boom"); }) as never);
    expect(await preflightUrl("https://api.example.com/mcp", false)).not.toBe("allowed");
  });
});

describe("IPv6 literal URLs", () => {
  afterEach(() => {
    vi.mocked(lookup).mockImplementation(async (host: string) =>
      [{ address: /^[\d.]+$/.test(host as string) ? (host as string) : "93.184.216.34", family: 4 }] as never);
  });

  it("resolves the address instead of reporting it unresolvable", async () => {
    // `URL.hostname` keeps the brackets (`"[::1]"`) and `dns.lookup` rejects that form, so
    // every v6 literal used to come back `unresolved` — and `isBlockedAddress` never saw the
    // address at all, leaving its whole v6 branch dead on this path.
    vi.mocked(lookup).mockImplementation(async (host: string) => {
      if ((host as string).startsWith("[")) throw new Error("EINVAL");
      return [{ address: host as string, family: 6 }] as never;
    });
    expect(await preflightUrl("http://[2606:4700::1111]/mcp", false)).toBe("allowed");
    // And a forbidden v6 address is now classified as BLOCKED, which is what it is.
    expect(await preflightUrl("http://[fe80::1]/mcp", false)).toBe("blocked");
    expect(await preflightUrl("http://[::1]/mcp", true)).toBe("blocked");
  });
});
