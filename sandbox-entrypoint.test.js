import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The egress firewall lives in bash, so it has no unit surface the way
// sandbox-spec.js does — yet its guarantees are exactly as load-bearing, and
// one of them is purely positional: iptables stops at the first matching rule,
// so the narrow "port 53 to the daemon-assigned resolver" ACCEPT is only
// effective while it sits ABOVE the private-range DROPs. Move it below them and
// DNS dies silently again (the bug this file exists to prevent); delete the
// DROPs' fail-closed `die` and the sandbox reaches the company LAN.
const script = readFileSync(
  fileURLToPath(new URL("./sandbox-entrypoint.sh", import.meta.url)),
  "utf8",
);

describe("sandbox egress firewall", () => {
  it("allows DNS to the container's own resolver before dropping private ranges", () => {
    const dnsAccept = script.indexOf("--dport 53 -j ACCEPT");
    const privateDrop = script.indexOf('for net in $PRIVATE_V4');
    expect(dnsAccept).toBeGreaterThan(-1);
    expect(privateDrop).toBeGreaterThan(-1);
    expect(dnsAccept).toBeLessThan(privateDrop);
  });

  // TODO(you): pin the *narrowness* of that exception.
  //
  // The rule is safe only because it is scoped to one address and one port. A
  // future edit that broadens it — dropping `--dport 53`, or switching the awk
  // extraction to something that lets a non-IPv4 token through — would hand the
  // sandbox a general LAN hole while every other test still passes.
  //
  // Assert whatever you consider the real invariant here.
  it.todo("keeps the DNS exception scoped to one address and one port");
});
