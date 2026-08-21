/**
 * The egress allowlist: what a sandbox is permitted to connect to, decided as a
 * pure function so every trap below is unit-testable without a socket.
 *
 * This is a HOSTNAME allowlist enforced by a proxy that resolves and dials the
 * destination itself — the agent never picks the IP. That is what makes it stronger
 * than SNI filtering, where the name is a string the client chooses and one curl
 * flag redirects it. It is weaker than TLS interception in exactly one way, and the
 * limit is worth stating plainly: a tunnel to an allowed host can carry a request
 * for a different virtual host on the same address (domain fronting). Nothing short
 * of MITM closes that, so the mitigation is a policy one — allow narrow,
 * single-purpose hosts, not a CDN apex that fronts half the internet.
 *
 * The class of bug this file is written against is host-string parsing. A published
 * bypass of exactly this design matched `attacker.com\0.google.com` against
 * `*.google.com`, because a JS suffix test says "allow" while getaddrinfo truncates
 * at the NUL and dials `attacker.com`. Any check that decides on a string the
 * resolver will read differently is decorative, so canonicalization here runs
 * through the same URL parser semantics the resolver ends up agreeing with, and
 * anything it refuses to parse is refused outright.
 */

import { isIP } from "node:net";

/** The port a bare entry grants. Everything else must be named explicitly: an
 *  allowlisted host reachable on ANY port is an SSH/SMTP tunnel with extra steps,
 *  which is why Squid ships `deny CONNECT !SSL_ports` out of the box. */
export const DEFAULT_PORT = 443;

/** Only a plain 1–65535 counts as a port. Deliberately strict so a smuggled
 *  `evil.com:443.allowed.com` is never split into a host and a port — it stays one
 *  string and then fails host validation, which is the answer we want. */
function parsePort(raw) {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 65535 ? n : null;
}

/**
 * A host in the one spelling the resolver will act on, or null if it is not a host
 * at all.
 *
 * Everything here is a normalization the resolver performs and a string comparison
 * would miss: `2852039166`, `0177.0.0.1`, `0x7f.0.0.1` and `127.1` all name an
 * address that is nothing like their text, uppercase and IDN have canonical forms,
 * and a trailing dot is the same name in DNS. The URL parser does all of that and
 * additionally REFUSES the hostile shapes — a raw or percent-encoded NUL, a `%`
 * zone id, whitespace, encoded CRLF — which is why a parse failure is a refusal
 * here and never a fallback to the raw text.
 */
export function canonicalizeHost(raw) {
  if (typeof raw !== "string" || raw === "" || raw.length > 253) return null;
  // Reject the specific bytes that make a host mean two different things, BEFORE
  // parsing, so the verdict never rests solely on one parser's version-to-version
  // behaviour: control characters and NUL (the truncation bypass), `%` (percent
  // decoding and the IPv6 zone id that smuggles an address past a suffix match),
  // and whitespace. Everything else is left to the parser — which is what lets an
  // operator write a real IDN domain and have it punycoded instead of dropped.
  if (/[\u0000-\u0020\u007f%]/.test(raw)) return null;
  let host;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    // A bare, unbracketed IPv6 literal is a host but not a valid URL host. Bracket
    // it and re-parse, so it still goes through the same normalization (`::0:1` and
    // `::1` are one address). The URL parser stays FIRST for everything else: the
    // shorthand v4 forms above must never take a shortcut around it.
    if (isIP(raw) !== 6) return null;
    try {
      host = new URL(`http://[${raw}]/`).hostname;
    } catch {
      return null;
    }
  }
  if (!host) return null;
  // `pypi.org.` and `pypi.org` are the same name; the parser keeps the dot.
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  // An IPv6 literal comes back bracketed. Carry it unbracketed so it compares
  // against a resolver answer and against `isIP`.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host || null;
}

/**
 * Split `host:port` from a request line or CONNECT target.
 *
 * An unbracketed string with several colons is never split: `::1:443` is itself a
 * valid address, so guessing a port out of it invents a destination the client did
 * not ask for.
 */
export function parseAuthority(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let hostPart = raw;
  let port = DEFAULT_PORT;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close === -1) return null;
    hostPart = raw.slice(0, close + 1);
    const rest = raw.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      const p = parsePort(rest.slice(1));
      if (p === null) return null;
      port = p;
    }
  } else {
    const colons = (raw.match(/:/g) || []).length;
    if (colons === 1) {
      const [h, p] = raw.split(":");
      const parsed = parsePort(p);
      if (parsed === null) return null;
      hostPart = h;
      port = parsed;
    } else if (colons > 1) {
      // Bare IPv6, or garbage. Either way it is not a host:port.
      hostPart = raw;
    }
  }
  const host = canonicalizeHost(hostPart);
  return host ? { host, port } : null;
}

/**
 * Parse the operator's list into entries, plus the entries it had to reject.
 *
 * A malformed entry is DROPPED, never widened into something permissive: dropping
 * narrows the policy, and narrowing is the safe direction to fail. The rejects are
 * returned so startup can say so out loud instead of quietly enforcing less than
 * the operator wrote.
 *
 * Grammar, chosen to be unsurprising rather than convenient:
 *   example.com        exact host, port 443
 *   *.example.com      subdomains of example.com, NOT the apex, port 443
 *   example.com:8443   exact host, that port only
 *   93.184.216.34      exact address, port 443
 * The apex is excluded from a wildcard on purpose — it is the reading every
 * security-focused tool in this space uses, and the alternative silently grants a
 * host the operator did not name. List both lines when you want both.
 */
export function parseAllowlist(raw) {
  const entries = [];
  const rejected = [];
  for (const token of String(raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    // `*` would mean "allow everything", which is what NOT configuring an allowlist
    // already means. Accepting it here would turn a typo into open egress.
    if (token === "*") { rejected.push(token); continue; }
    let body = token;
    let port = DEFAULT_PORT;
    const wildcard = body.startsWith("*.");
    if (wildcard) body = body.slice(2);
    // Same strict split as a request authority, so config and traffic agree.
    const authority = parseAuthority(body);
    if (!authority) { rejected.push(token); continue; }
    ({ port } = authority);
    const host = authority.host;
    // A wildcard over an address means nothing, and pretending it does is how a
    // zone-id or embedded-v4 spelling gets to ride a suffix match.
    if (wildcard && isIP(host)) { rejected.push(token); continue; }
    // A wildcard needs something to be a subdomain OF.
    if (wildcard && !host.includes(".")) { rejected.push(token); continue; }
    entries.push({ host, port, wildcard });
  }
  return { entries, rejected };
}

/**
 * Whether `entries` permit this host and port.
 *
 * An empty list denies everything. That is the whole behaviour of the sentence, and
 * it is written down because the opposite reading — empty means unrestricted — has
 * already shipped as a CVE in a comparable sandbox. "Allowlist configured but empty"
 * must never be the most permissive state in the system.
 */
export function isAllowed(host, port, entries) {
  for (const e of entries) {
    if (e.port !== port) continue;
    if (e.wildcard) {
      // The dot is load-bearing: `endsWith("github.com")` also matches
      // `evilgithub.com`. And an address never matches a name pattern.
      if (!isIP(host) && host.endsWith(`.${e.host}`)) return true;
    } else if (host === e.host) {
      return true;
    }
  }
  return false;
}

/**
 * The decision for one request, from its raw authority. Returns the canonical host
 * and port to dial — the caller must resolve THAT host and connect to a validated
 * address (see ip-guard.js), because a name on the list can still resolve to
 * loopback, the metadata service, or the host's own database.
 */
export function decide(rawAuthority, entries) {
  const authority = parseAuthority(rawAuthority);
  if (!authority) return { ok: false, reason: "invalid_host" };
  if (!isAllowed(authority.host, authority.port, entries)) {
    return { ok: false, reason: "not_allowed", host: authority.host, port: authority.port };
  }
  return { ok: true, host: authority.host, port: authority.port };
}
