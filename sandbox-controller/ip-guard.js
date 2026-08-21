/**
 * Address classification for outbound connections — the ONE implementation.
 *
 * Plain JS in this directory on purpose: it has two consumers in two packages that
 * cannot import each other. The platform's SSRF guard (`src/lib/net/ssrf.ts`) needs
 * it for user-supplied URLs, and the egress proxy needs it for the address a
 * sandbox's allowlisted hostname actually resolves to — and the controller image is
 * built from this directory alone, so a shared file has to live here to reach it.
 *
 * A second copy is what this file exists to prevent: the v6-wrapped-v4 forms below
 * were a real hole once, closed by reasoning about BYTES rather than string prefixes,
 * and two copies of that reasoning would drift apart exactly where it is hardest to
 * notice. `src/lib/net/__tests__/ssrf.test.ts` holds the vectors.
 */
import { isIPv4, isIPv6 } from "node:net";

/**
 * An IPv6 literal as its 16 bytes, or null if it isn't one.
 *
 * Written out rather than leaning on `new URL()` because that normalizes in the WRONG
 * DIRECTION for this check: it rewrites `::ffff:169.254.169.254` — the dotted form the old
 * `startsWith("::ffff:")` slice actually handled — into `::ffff:a9fe:a9fe`, which that slice
 * did not. Deciding a security question on any string shape means deciding it on whichever
 * of a dozen spellings the resolver happened to hand back.
 */
function ipv6Bytes(ip) {
  if (!isIPv6(ip)) return null;
  const [head, tail] = ip.split("::");
  const toWords = (part) => {
    if (!part) return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    // A trailing dotted quad (`::ffff:1.2.3.4`, `::1.2.3.4`) is two words, not one group.
    if (last.includes(".")) {
      const quad = last.split(".").map(Number);
      return [...groups.slice(0, -1).map((g) => parseInt(g, 16)), (quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    }
    return groups.map((g) => parseInt(g, 16));
  };
  const left = toWords(head);
  const right = tail === undefined ? [] : toWords(tail);
  if (tail === undefined && left.length !== 8) return null;
  const words = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[i * 2] = w >> 8; out[i * 2 + 1] = w & 0xff; });
  return out;
}

/**
 * RFC 8215's local-use NAT64 prefix, `64:ff9b:1::/48`. Kept separate from the well-known
 * `64:ff9b::/96` because the two carry their embedded v4 address in different bytes.
 */
function isLocalUseNat64(b) {
  return b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01;
}

/**
 * An IPv4 address carried inside an IPv6 one, in dotted form — or null.
 *
 * Four encodings reach the same v4 host and every one of them used to sail past the guard
 * whenever it was spelled in hex: IPv4-mapped (`::ffff:a9fe:a9fe`), the deprecated
 * IPv4-compatible form (`::7f00:1`), and the two NAT64 prefixes — well-known
 * (`64:ff9b::a9fe:a9fe`) and local-use (`64:ff9b:1:a9fe:a9:fe00::`). A hostile hostname simply
 * publishes an AAAA record in one of them, so the metadata service and loopback were reachable
 * through a check that believed it had covered them.
 *
 * Which BYTES hold the address depends on the prefix length, not on taste: RFC 6052 packs the
 * four octets into the 32 bits that follow the prefix and steps over the "u" octet at byte 8,
 * which MUST be zero. A /96 prefix therefore leaves them in the last four bytes, while the /48
 * local-use prefix splits them 6,7 | 9,10.
 */
function embeddedIPv4(b) {
  const zeros = (from, to) => b.subarray(from, to).every((x) => x === 0);
  const dotted = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  // ::ffff:a.b.c.d
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return dotted();
  // 64:ff9b::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return dotted();
  // 64:ff9b:1:a.b:0:c.d::
  if (isLocalUseNat64(b) && b[8] === 0) return `${b[6]}.${b[7]}.${b[9]}.${b[10]}`;
  // ::a.b.c.d — but NOT `::` or `::1`, which are their own v6 cases below.
  if (zeros(0, 12) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] <= 1)) return dotted();
  return null;
}

export function isBlockedAddress(ip, blockPrivate) {
  const bytes = ipv6Bytes(ip);
  // Resolve any v6-wrapped v4 address to the v4 rules, which are the ones that actually
  // describe it. Every spelling collapses to one decision here.
  const v4 = bytes ? embeddedIPv4(bytes) ?? ip : ip;
  if (isIPv4(v4)) {
    const o = v4.split(".").map(Number);
    // Always blocked, regardless of the private-range policy: "this host" (0.0.0.0/8
    // routes to loopback on Linux — a classic metadata/loopback SSRF bypass),
    // link-local / cloud metadata (169.254/16), and multicast + reserved/broadcast
    // (>=224). None is ever a legitimate fetch target.
    if (o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] >= 224) return true;
    if (!blockPrivate) return false;
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  // Anything that is neither a v4 address nor a parseable v6 one is refused rather than
  // allowed: this decides whether to open a connection, and "unrecognized" is not evidence
  // of being safe. The old string tests simply fell through to `return false` here.
  if (!bytes) return true;

  const prefixIsZero = (n) => bytes.subarray(0, n).every((x) => x === 0);
  // Always blocked, whatever the private-range policy says: the unspecified address (binds
  // and routes to loopback), link-local (fe80::/10), and multicast (ff00::/8). Tested on
  // bytes, not on the leading characters — `0:0:0:0:0:0:0:1` is a perfectly ordinary way to
  // write loopback and matched none of the old prefixes.
  if (prefixIsZero(16)) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  // Whatever is left of 64:ff9b:1::/48 — the prefix carrying a non-zero "u" octet, which RFC 6052
  // forbids, so `embeddedIPv4` refused to read an address out of it. RFC 8215 states the prefix is
  // not globally reachable, so there is no destination behind it worth reaching by a spelling we
  // cannot decode. Unconditional: a NAT64 translator answers for it regardless of the private-range
  // policy, which is exactly what made the metadata service reachable through it.
  if (isLocalUseNat64(bytes)) return true;
  if (!blockPrivate) return false;
  if (prefixIsZero(15) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  return false;
}
