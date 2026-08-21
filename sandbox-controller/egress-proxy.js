/**
 * The egress proxy: the ONLY path from a sandbox to the internet when an allowlist
 * is configured.
 *
 * Runs as its own container from the controller image (no Docker socket, no
 * database, no secrets — see docker-compose.yml). Sandboxes sit on an `internal`
 * Docker network with no route off the bridge, this process is the one member that
 * is also on an outward network, and the sandbox's own iptables permits nothing but
 * this address and port. Three layers, because the interesting failure is one of
 * them silently not enforcing: gVisor's netfilter is partial, and an `internal`
 * network still reaches the Docker host's own gateway and its sibling containers.
 *
 * CONNECT only, on purpose. Forwarding plain HTTP means owning hop-by-hop headers
 * and request smuggling inside a security decision, and a half-working http:// path
 * is worse than none: the sandbox is given HTTPS_PROXY and no HTTP_PROXY, so an
 * http:// request goes direct and dies on the firewall instead of arriving here in
 * a shape this file has to reason about.
 *
 * What the agent picks is a NAME. What gets dialed is an address this process
 * resolved and checked. That order is the whole point — it is what makes this
 * stronger than SNI filtering, where the destination address is the client's choice.
 */

import { createServer } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { log } from "./log.js";
import { isBlockedAddress } from "./ip-guard.js";
import { parseAllowlist, decide } from "./egress-policy.js";

const STATUS_TEXT = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway", 503: "Service Unavailable" };

/**
 * The address to dial for `host`, or null if it must not be dialed.
 *
 * A name on the allowlist is not yet a destination: it can resolve to loopback, to
 * the metadata service, to this deployment's own Postgres. So every answer is
 * checked and the connection is pinned to a checked address — re-resolving at
 * connect time would be a second lookup with a possibly different answer, which is
 * the rebinding bug itself.
 *
 * If ANY answer is blocked the whole name is refused rather than filtered down to
 * the acceptable ones. A mixed answer set is either hostile or split-horizon, and
 * picking the survivor out of it is how rebinding gets a second chance.
 */
export async function pinnedAddress(host, resolve = lookup) {
  const literal = isIP(host);
  if (literal) return isBlockedAddress(host, true) ? null : { address: host, family: literal };
  let addrs;
  try {
    addrs = await resolve(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (!addrs?.length) return null;
  if (addrs.some((a) => isBlockedAddress(a.address, true))) return null;
  return addrs[0];
}

/**
 * An HTTP CONNECT proxy that tunnels only to `entries`.
 *
 * `deps` exists for tests: the DNS resolver and the dialer are the two edges that
 * would otherwise need a real network to exercise a policy decision.
 */
export function createEgressProxy(entries, deps = {}) {
  const {
    resolve = lookup,
    dial = netConnect,
    maxTunnels = Number(process.env.EGRESS_MAX_TUNNELS) || 256,
    idleMs = Number(process.env.EGRESS_IDLE_MS) || 120_000,
    connectMs = Number(process.env.EGRESS_CONNECT_MS) || 10_000,
  } = deps;

  let live = 0;

  /** Refuse with a status the client can act on, and say why exactly once. Never
   *  echoes the request line — it is attacker-controlled and a userinfo field in it
   *  would put credentials in the log. */
  function refuse(socket, status, reason, fields) {
    log("egress.deny", { reason, ...fields }, "warn");
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n` +
        "Proxy-Agent: capka-egress\r\n" +
        `X-Capka-Egress-Reason: ${reason}\r\n` +
        "Content-Length: 0\r\n\r\n");
    }
    socket.destroy();
  }

  const server = createServer((req, res) => {
    // Anything that is not CONNECT carries no destination this proxy will dial.
    // Answered explicitly rather than dropped, so a misconfigured HTTP_PROXY shows
    // up as a refusal in the tool's own output instead of a hang.
    log("egress.deny", { reason: "not_connect", method: req.method }, "warn");
    res.writeHead(405, { "Content-Length": "0", "Proxy-Agent": "capka-egress" });
    res.end();
  });

  server.on("connect", (req, clientSocket, head) => {
    void (async () => {
      if (live >= maxTunnels) return refuse(clientSocket, 503, "too_many_tunnels", {});

      const verdict = decide(req.url, entries);
      if (!verdict.ok) {
        // `host` is absent when the authority didn't parse; the raw string stays out
        // of the log on purpose.
        return refuse(clientSocket, 403, verdict.reason,
          verdict.host ? { host: verdict.host, port: verdict.port } : {});
      }

      const addr = await pinnedAddress(verdict.host, resolve);
      if (!addr) return refuse(clientSocket, 403, "blocked_address", { host: verdict.host, port: verdict.port });

      const upstream = dial({ host: addr.address, port: verdict.port, family: addr.family });
      upstream.setTimeout(connectMs, () => upstream.destroy(new Error("connect timeout")));

      upstream.once("connect", () => {
        live++;
        log("egress.allow", { host: verdict.host, port: verdict.port, address: addr.address });
        upstream.setTimeout(0);
        // Idle, not total: a long download is legitimate, a socket parked open is not.
        for (const s of [clientSocket, upstream]) {
          s.setTimeout(idleMs, () => s.destroy());
          s.setNoDelay?.(true);
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: capka-egress\r\n\r\n");
        // Bytes the client sent right after its CONNECT line, before we replied.
        if (head?.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          live--;
          clientSocket.destroy();
          upstream.destroy();
        };
        clientSocket.once("close", close);
        upstream.once("close", close);
      });

      upstream.once("error", (e) => {
        // Why the upstream failed goes to the operator's log, not back to the
        // sandbox: "refused" vs "timed out" for an arbitrary address is a port
        // scanner's oracle.
        log("egress.upstream_error", { host: verdict.host, port: verdict.port, err: e.code || e.message }, "warn");
        if (!clientSocket.destroyed) refuse(clientSocket, 502, "upstream_unreachable", { host: verdict.host });
      });
      clientSocket.once("error", () => upstream.destroy());
    })();
  });

  // A client that opens a socket and never finishes its request line must not hold a
  // slot forever.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}

/** Started only when this file is the entrypoint, so importing it in a test does
 *  not bind a port. */
if (process.argv[1] && process.argv[1].endsWith("egress-proxy.js")) {
  const port = Number(process.env.EGRESS_PROXY_PORT) || 3128;
  /** The proxy is multi-homed by design (internal + outward), so the listener is
   *  bindable: an operator who wants it pinned to the internal interface can say so.
   *  The outward network has no other members and no published ports, which is what
   *  makes the default safe rather than merely convenient. */
  const bind = process.env.EGRESS_PROXY_BIND || "0.0.0.0";
  const { entries, rejected } = parseAllowlist(process.env.SANDBOX_EGRESS_ALLOW);
  createEgressProxy(entries).listen(port, bind, () => {
    log("egress.listening", {
      port, bind, allowed: entries.length,
      // Say the policy out loud at boot: "configured but empty" denies everything,
      // and an operator who mistyped every entry should learn that here rather than
      // from a wall of refusals.
      hosts: entries.map((e) => `${e.wildcard ? "*." : ""}${e.host}:${e.port}`),
    });
    if (rejected.length) log("egress.allowlist_rejected", { entries: rejected }, "warn");
    if (!entries.length) log("egress.empty_allowlist", { note: "no host is reachable from any sandbox" }, "warn");
  });
}
