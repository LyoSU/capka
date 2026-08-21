import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

// ── Executing the script, not reading it ─────────────────────────────────────
// The assertions above can only see text. These RUN the thing against stub
// iptables/getent binaries and read back what it actually tried to do — which is
// the only way to pin rule ORDER and, more importantly, that every failure path
// exits non-zero instead of leaving a container with open egress.
const SCRIPT = fileURLToPath(new URL("./sandbox-entrypoint.sh", import.meta.url));

function runEntrypoint({ env = {}, stubs = {}, omit = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capka-ep-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls.log");
  const defaults = {
    chown: "exit 0",
    // Stops the script's final `exec setpriv … sleep infinity` from hanging the test.
    setpriv: "exit 0",
    iptables: "exit 0",
    ip6tables: "exit 0",
    getent: 'echo "10.88.7.2 STREAM capka-egress-proxy"; exit 0',
    // 124 is what a killed connect reports, i.e. "the DROP is being enforced".
    // Stubbed rather than left real so the suite runs on a macOS dev box (no
    // coreutils `timeout`) and never spends a second per case waiting on a socket.
    timeout: "exit 124",
  };
  for (const [name, body] of Object.entries({ ...defaults, ...stubs })) {
    if (omit.includes(name)) continue;
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // /usr/sbin is left OUT so an omitted stub is genuinely missing on a CI runner
  // that ships the real iptables there.
  const res = spawnSync("bash", [SCRIPT], {
    env: { PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, SANDBOX_EGRESS_FILTER: "1", ...env },
    encoding: "utf8",
  });
  const log = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: res.status, stderr: res.stderr, log, rules: log.filter((l) => l.startsWith("iptables ")) };
}

describe("sandbox egress firewall — default-deny (allowlist mode)", () => {
  const PROXY = { SANDBOX_EGRESS_PROXY: "capka-egress-proxy:3128" };

  it("permits loopback and the proxy, then drops everything, in that order", () => {
    const { status, rules } = runEntrypoint({ env: PROXY });
    expect(status).toBe(0);
    const idx = (needle) => rules.findIndex((r) => r.includes(needle));
    expect(idx("-F OUTPUT")).toBe(0);
    expect(idx("-o lo -j ACCEPT")).toBeGreaterThan(idx("-F OUTPUT"));
    // Pinned to the ADDRESS the name resolved to, and to the proxy's port only.
    expect(idx("-d 10.88.7.2 -p tcp --dport 3128 -j ACCEPT")).toBeGreaterThan(idx("-o lo -j ACCEPT"));
    // The DROP is last, or everything above it is decoration.
    expect(idx("-A OUTPUT -j DROP")).toBe(rules.findLastIndex((r) => r.includes("-A OUTPUT")));
    // And it verifies the DROP actually took, the way the metadata rule is verified.
    expect(rules.some((r) => r.includes("-C OUTPUT -j DROP"))).toBe(true);
  });

  it("opens nothing else: no DNS hole, no blanket ACCEPT", () => {
    const { rules } = runEntrypoint({ env: PROXY });
    // With CONNECT the proxy resolves the name, so the sandbox needs no resolver —
    // and no UDP at all means no DNS tunnelling and no QUIC.
    expect(rules.some((r) => r.includes("--dport 53"))).toBe(false);
    expect(rules.some((r) => r.includes("-A OUTPUT -j ACCEPT"))).toBe(false);
  });

  // `-C` says the rule is in the table; under gVisor's partial netfilter that is
  // not the same as the table being consulted, and this DROP is the only thing
  // keeping a sandbox off its neighbours on the shared egress network.
  it("probes the DROP for enforcement, at the resolved address and a port it did not grant", () => {
    const { status, log } = runEntrypoint({ env: PROXY });
    expect(status).toBe(0);
    const probe = log.find((l) => l.startsWith("timeout "));
    expect(probe).toBeDefined();
    expect(probe).toContain("/dev/tcp/10.88.7.2/9");
    expect(probe).not.toContain("/3128"); // the granted port would prove nothing
  });

  it("refuses to run when the probe shows the DROP is not enforced", () => {
    // Refused immediately: the SYN reached a live host, so nothing filtered it.
    const refused = runEntrypoint({ env: PROXY, stubs: { timeout: "exit 1" } });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/not enforced/);
    // Connected: worse, and equally not a filtered path.
    const open = runEntrypoint({ env: PROXY, stubs: { timeout: "exit 0" } });
    expect(open.status).not.toBe(0);
    expect(open.stderr).toMatch(/not enforced/);
  });

  it("refuses to run when it cannot run the probe at all", () => {
    const { status, stderr } = runEntrypoint({ env: PROXY, omit: ["timeout"] });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/timeout\(1\) is unavailable/);
  });

  it("refuses to run when the proxy cannot be resolved", () => {
    const { status, stderr, rules } = runEntrypoint({ env: PROXY, stubs: { getent: "exit 2" } });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/cannot resolve the egress proxy/);
    // Bails BEFORE touching the rules, so it can't half-install a policy.
    expect(rules).toEqual([]);
  });

  it("refuses a malformed proxy endpoint", () => {
    for (const bad of ["capka-egress-proxy", "capka-egress-proxy:", ":3128", "host:notaport"]) {
      const { status, stderr } = runEntrypoint({ env: { SANDBOX_EGRESS_PROXY: bad } });
      expect(status, bad).not.toBe(0);
      expect(stderr, bad).toMatch(/egress proxy endpoint|cannot resolve/);
    }
  });

  it("refuses to run without iptables rather than falling through to open egress", () => {
    const { status, stderr } = runEntrypoint({ env: PROXY, omit: ["iptables"] });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/iptables is unavailable/);
  });

  it("fails closed on any single rule that does not install", () => {
    // Each rule is load-bearing; a swallowed failure is an open container.
    const { status, stderr } = runEntrypoint({
      env: PROXY,
      stubs: { iptables: 'case "$*" in *"-j DROP"*) exit 1 ;; esac\nexit 0' },
    });
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/default-deny/);
  });

  // Only meaningful where the kernel actually has IPv6 — i.e. the Linux CI runner,
  // not a macOS dev box, which has no /proc at all.
  it.runIf(existsSync("/proc/net/if_inet6"))("closes IPv6 completely, and fatally", () => {
    const { status, log } = runEntrypoint({ env: PROXY });
    expect(status).toBe(0);
    const v6 = log.filter((l) => l.startsWith("ip6tables "));
    expect(v6.some((r) => r.includes("-A OUTPUT -j DROP"))).toBe(true);
    expect(v6.some((r) => r.includes("-A OUTPUT -j ACCEPT"))).toBe(false);
    // Missing ip6tables on a v6-capable host is a refusal: an unfiltered v6 stack
    // routes straight around the allowlist.
    const missing = runEntrypoint({ env: PROXY, omit: ["ip6tables"] });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/IPv6 is present but ip6tables is not/);
  });
});

describe("sandbox egress firewall — the open-egress mode is unchanged", () => {
  it("still drops the private ranges and then accepts the public internet", () => {
    const { status, rules } = runEntrypoint(); // no SANDBOX_EGRESS_PROXY
    expect(status).toBe(0);
    expect(rules.some((r) => r.includes("-d 169.254.0.0/16 -j DROP"))).toBe(true);
    expect(rules.some((r) => r.includes("-A OUTPUT -j ACCEPT"))).toBe(true);
    // No proxy rule anywhere near it.
    expect(rules.some((r) => r.includes("--dport 3128"))).toBe(false);
  });

  // It used to be every-rule-`|| true`, skipped entirely when ip6tables was absent:
  // a v6-capable host kept an unfiltered v6 path to the LAN and to the ULA/link-local
  // metadata addresses while the v4 rules made the container look protected.
  it.runIf(existsSync("/proc/net/if_inet6"))("fails closed on IPv6 too, instead of best-effort", () => {
    const { status, log } = runEntrypoint();
    expect(status).toBe(0);
    const v6 = log.filter((l) => l.startsWith("ip6tables "));
    expect(v6.some((r) => r.includes("-d fe80::/10 -j DROP"))).toBe(true);
    expect(v6.some((r) => r.includes("-C OUTPUT -d fe80::/10 -j DROP"))).toBe(true);

    const missing = runEntrypoint({ omit: ["ip6tables"] });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/IPv6 is present but ip6tables is not/);

    const broken = runEntrypoint({ stubs: { ip6tables: 'case "$*" in *"fc00::/7"*) exit 1 ;; esac\nexit 0' } });
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/ip6tables DROP fc00::\/7 failed/);
  });

  it("installs no firewall at all when egress is off", () => {
    const { status, rules } = runEntrypoint({ env: { SANDBOX_EGRESS_FILTER: "0" } });
    expect(status).toBe(0);
    expect(rules).toEqual([]);
  });
});
