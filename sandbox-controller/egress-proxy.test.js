import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, connect } from "node:net";
import { createEgressProxy, pinnedAddress } from "./egress-proxy.js";
import { parseAllowlist } from "./egress-policy.js";

// Real sockets, no Docker, no network: the DNS answer and the dialer are injected,
// so a policy decision can be driven end to end against a local echo server.
const ALLOW = parseAllowlist("pypi.org, *.githubusercontent.com, internal.example.com:8080").entries;
const PUBLIC = "93.184.216.34"; // what the fake resolver answers with

let echo, echoPort, proxy, proxyPort, dial;
const echoSockets = new Set();
/** A socket that completed CONNECT is DETACHED from the http server, so
 *  closeAllConnections() does not reach it and close() waits on it forever. Every
 *  client socket is tracked so teardown can end them itself. */
const clientSockets = new Set();

/** close() alone waits for live tunnels — which is the point of a tunnel, so the
 *  sockets have to go first or teardown hangs. */
async function closeServer(s) {
  s.closeAllConnections?.();
  await new Promise((r) => s.close(r));
}

function startProxy(entries, deps = {}) {
  const server = createEgressProxy(entries, {
    resolve: async () => [{ address: PUBLIC, family: 4 }],
    // Every allowed dial lands on the local echo server, whatever address the
    // policy pinned — the point under test is the decision, not the routing.
    dial: (opts) => { dial(opts); return connect({ host: "127.0.0.1", port: echoPort }); },
    ...deps,
  });
  return server;
}

/** Send one CONNECT and return the status line + refusal reason, plus the socket. */
function sendConnect(port, authority) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port }, () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    clientSockets.add(sock);
    sock.on("close", () => clientSockets.delete(sock));
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      if (buf.includes("\r\n\r\n")) {
        const status = Number(buf.split(" ")[1]);
        const reason = buf.match(/X-Capka-Egress-Reason: (\S+)/)?.[1] ?? null;
        resolve({ status, reason, sock, head: buf });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("no response")), 4000);
  });
}

beforeAll(async () => {
  // Stands in for the allowlisted origin; echoes so a tunnel can be proven to carry
  // bytes rather than merely to open.
  echo = createServer((s) => { echoSockets.add(s); s.on("close", () => echoSockets.delete(s)); s.pipe(s); });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = echo.address().port;
  dial = vi.fn();
  proxy = startProxy(ALLOW);
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = proxy.address().port;
});

afterAll(async () => {
  for (const s of clientSockets) s.destroy();
  await closeServer(proxy);
  for (const s of echoSockets) s.destroy();
  await closeServer(echo);
});

describe("egress proxy — CONNECT", () => {
  it("tunnels to an allowed host and carries bytes both ways", async () => {
    const { status, sock } = await sendConnect(proxyPort, "pypi.org:443");
    expect(status).toBe(200);
    const echoed = await new Promise((resolve) => {
      sock.once("data", (c) => resolve(c.toString()));
      sock.write("ping");
    });
    expect(echoed).toBe("ping");
    // It dialed the address the policy pinned, not the name the client asked for.
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", port: 443 }));
    sock.destroy();
  });

  it("matches a wildcard entry on a subdomain but not on its apex", async () => {
    const ok = await sendConnect(proxyPort, "raw.githubusercontent.com:443");
    expect(ok.status).toBe(200);
    ok.sock.destroy();
    const apex = await sendConnect(proxyPort, "githubusercontent.com:443");
    expect(apex).toMatchObject({ status: 403, reason: "not_allowed" });
  });

  it("refuses a host that is not on the list", async () => {
    expect(await sendConnect(proxyPort, "evil.example:443")).toMatchObject({ status: 403, reason: "not_allowed" });
  });

  // Naming a host does not grant every port on it — that is an SSH tunnel.
  it("refuses an allowed host on a port that was not granted", async () => {
    expect(await sendConnect(proxyPort, "pypi.org:22")).toMatchObject({ status: 403, reason: "not_allowed" });
    expect(await sendConnect(proxyPort, "internal.example.com:8080")).toMatchObject({ status: 200 });
  });

  it("refuses an authority it cannot parse, before any lookup", async () => {
    const r = await sendConnect(proxyPort, "attacker.com%00.pypi.org:443");
    expect(r).toMatchObject({ status: 403, reason: "invalid_host" });
  });

  it("answers a non-CONNECT request instead of hanging", async () => {
    const status = await new Promise((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port: proxyPort }, () => {
        s.write("GET http://pypi.org/simple HTTP/1.1\r\nHost: pypi.org\r\n\r\n");
      });
      s.on("data", (c) => resolve(Number(c.toString().split(" ")[1])));
      s.on("error", reject);
    });
    expect(status).toBe(405);
  });
});

describe("egress proxy — where the name actually points", () => {
  it("refuses an allowed name that resolves somewhere it must not reach", async () => {
    const server = startProxy(ALLOW, { resolve: async () => [{ address: "169.254.169.254", family: 4 }] });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const before = dial.mock.calls.length;
    const r = await sendConnect(server.address().port, "pypi.org:443");
    expect(r).toMatchObject({ status: 403, reason: "blocked_address" });
    expect(dial.mock.calls.length).toBe(before); // never dialed
    await closeServer(server);
  });

  // A mixed answer is hostile or split-horizon; picking the good one out of it is
  // how DNS rebinding gets its second chance.
  it("refuses the whole name when only one answer is blocked", async () => {
    const server = startProxy(ALLOW, {
      resolve: async () => [{ address: PUBLIC, family: 4 }, { address: "127.0.0.1", family: 4 }],
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    expect(await sendConnect(server.address().port, "pypi.org:443"))
      .toMatchObject({ status: 403, reason: "blocked_address" });
    await closeServer(server);
  });

  it("pins an address literal only after checking it", async () => {
    expect(await pinnedAddress("93.184.216.34")).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await pinnedAddress("169.254.169.254")).toBeNull();
    expect(await pinnedAddress("::ffff:169.254.169.254")).toBeNull(); // same address, v6 spelling
    expect(await pinnedAddress("127.0.0.1")).toBeNull();
    // A name that resolves to nothing is not a destination.
    expect(await pinnedAddress("nx.example", async () => [])).toBeNull();
    expect(await pinnedAddress("nx.example", async () => { throw new Error("ENOTFOUND"); })).toBeNull();
  });
});

describe("egress proxy — an empty allowlist is the strictest state", () => {
  it("refuses everything, including a host that would be reachable otherwise", async () => {
    const server = startProxy(parseAllowlist("").entries);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    expect(await sendConnect(server.address().port, "pypi.org:443"))
      .toMatchObject({ status: 403, reason: "not_allowed" });
    await closeServer(server);
  });
});
