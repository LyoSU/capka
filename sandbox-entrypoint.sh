#!/bin/bash
# The container starts as root SOLELY to repair the ownership of the bind-mounted
# workspace, then drops to the unprivileged sandbox user for everything else.
#
# Why this is needed: /workspace and /shared are bind-mounted from a host
# directory. Docker resolves that source on the daemon host, and when the host
# created it (or when Docker auto-creates a missing bind source) it is owned by
# root — so a process running as uid 1000 gets EACCES on the very first write
# ("mkdir: cannot create directory '/workspace/...': Permission denied"). Fixing
# ownership here, inside the container at startup, is robust no matter how the
# host produced the mount. We then setpriv-drop to uid 1000; the controller also
# pins every `docker exec` to 1000:1000, so no agent code ever runs as root.

set -u

chown sandbox:sandbox /shared 2>/dev/null || true
# /workspace is session-scoped and disk-capped, so a recursive repair is cheap and
# also heals any subdirectories a previous session left root-owned (e.g. uploads).
chown -R sandbox:sandbox /workspace 2>/dev/null || true

# Egress firewall (only when the platform turned networking on). Done here, as
# root with NET_ADMIN, BEFORE dropping to uid 1000 — the agent can't undo it.
# Allows the public internet + DNS but DROPs the private/internal ranges so a
# prompt-injected agent can't reach the company LAN or cloud metadata
# (169.254.169.254). Loopback covers Docker's embedded resolver (127.0.0.11).
# Return traffic arrives via INPUT (untouched), so no conntrack is needed —
# keeps it working under gVisor's limited netfilter.
die() { echo "sandbox-entrypoint: $1" >&2; exit 1; }

if [ "${SANDBOX_EGRESS_FILTER:-0}" = "1" ]; then
  # FAIL-CLOSED. Egress was turned on WITH a firewall, so the private/metadata DROP
  # rules are the only thing between a prompt-injected agent and the company LAN /
  # 169.254.169.254. If we can't install AND verify them, we must refuse to run —
  # never fall through to open egress (the old `command -v iptables` / `|| true`
  # form did exactly that when iptables was absent or the rules silently no-op'd).
  command -v iptables >/dev/null 2>&1 || die "egress filter requested but iptables is unavailable — refusing to run with open egress"

if [ -n "${SANDBOX_EGRESS_PROXY:-}" ]; then
  # DEFAULT-DENY. An allowlist is configured, so nothing leaves this container
  # except connections to the egress proxy, which decides per hostname (see
  # sandbox-controller/egress-proxy.js). The rule set is the whole design: ACCEPT
  # loopback, ACCEPT the proxy, DROP everything — in that order, because iptables
  # stops at the first match.
  #
  # There is deliberately NO DNS exception here. With CONNECT the proxy resolves
  # the name, so the sandbox needs no resolver of its own, and dropping everything
  # else removes DNS tunnelling and QUIC/HTTP3 in the same line. It is also why
  # this cannot be an addition to the rules below: the proxy sits on a Docker
  # network inside 192.168/16 or 10/8, which those rules DROP.
  #
  # This layer is not decoration even though the sandbox network is `internal`:
  # such a network still reaches the Docker host's own gateway and every sibling
  # container on it.
  proxy_host="${SANDBOX_EGRESS_PROXY%:*}"
  proxy_port="${SANDBOX_EGRESS_PROXY##*:}"
  [ -n "$proxy_host" ] || die "egress proxy endpoint is not host:port ($SANDBOX_EGRESS_PROXY)"
  case "$proxy_port" in ''|*[!0-9]*) die "egress proxy endpoint is not host:port ($SANDBOX_EGRESS_PROXY)" ;; esac
  # A rule has to name an address. Pinning it at startup also means a proxy that
  # later returns on a different address is a deliberate recreate rather than a
  # silent hole — and a name that resolves to nothing is a refusal to run, never a
  # container with no egress path and no explanation.
  proxy_ips=$(getent ahostsv4 "$proxy_host" 2>/dev/null | awk '{print $1}' | sort -u)
  [ -n "$proxy_ips" ] || die "cannot resolve the egress proxy ($proxy_host) — refusing to run"
  iptables -F OUTPUT || die "iptables flush failed"
  iptables -A OUTPUT -o lo -j ACCEPT || die "iptables loopback rule failed"
  for ip in $proxy_ips; do
    iptables -A OUTPUT -d "$ip" -p tcp --dport "$proxy_port" -j ACCEPT || die "iptables proxy rule for $ip failed"
  done
  iptables -A OUTPUT -j DROP || die "iptables default-deny rule failed"
  iptables -C OUTPUT -j DROP 2>/dev/null || die "egress default-deny did not install — refusing to run"
  # `-C` proves the rule is in the TABLE. It does not prove the table is consulted:
  # gVisor's netfilter is partial, and a rule it accepted can still not filter. That
  # distinction matters most for the one guarantee nothing else covers — this DROP is
  # all that keeps one sandbox off its NEIGHBOURS on the shared egress network, which
  # `internal` does not isolate.
  #
  # So probe it, on a port of the proxy that was not granted. Enforced => the SYN goes
  # nowhere, the connect hangs and timeout kills it (124). Not enforced => nothing is
  # listening there, the kernel answers RST and bash fails at once (1); a live listener
  # would connect (0). 124 is the only acceptable answer, which is why the other two
  # are fatal. The one thing this cannot see is a proxy that is down: an address with
  # nothing behind it also times out, so the probe proves enforcement whenever the
  # target is live and is merely silent when it is not.
  command -v timeout >/dev/null 2>&1 || die "timeout(1) is unavailable, so the default-deny cannot be verified — refusing to run"
  probe_ip=$(echo "$proxy_ips" | head -n1)
  timeout 1 bash -c "exec 3<>/dev/tcp/$probe_ip/9" 2>/dev/null
  probe_rc=$?
  [ "$probe_rc" -eq 124 ] || die "egress default-deny is in the table but not enforced (probe of $probe_ip:9 exited $probe_rc, expected a timeout) — refusing to run"
  # IPv6 has no proxy path, so it is closed completely. FATAL here, unlike the
  # best-effort v6 handling in the open-egress branch below: a v6-capable host with
  # an unfiltered v6 stack would route straight around the allowlist.
  if [ -e /proc/net/if_inet6 ]; then
    command -v ip6tables >/dev/null 2>&1 || die "IPv6 is present but ip6tables is not — refusing to run with unfiltered IPv6 egress"
    ip6tables -F OUTPUT || die "ip6tables flush failed"
    ip6tables -A OUTPUT -o lo -j ACCEPT || die "ip6tables loopback rule failed"
    ip6tables -A OUTPUT -j DROP || die "ip6tables default-deny rule failed"
    ip6tables -C OUTPUT -j DROP 2>/dev/null || die "IPv6 default-deny did not install — refusing to run"
  fi
else
  PRIVATE_V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 192.0.0.0/24 198.18.0.0/15"
  iptables -F OUTPUT || die "iptables flush failed"
  iptables -A OUTPUT -o lo -j ACCEPT || die "iptables loopback rule failed"
  # DNS, BEFORE the DROPs (iptables stops at the first match). Docker's *default*
  # bridge has no embedded resolver at 127.0.0.11 — the container inherits the
  # host's /etc/resolv.conf verbatim, and that resolver is very often itself
  # private: 192.168.65.x on Docker Desktop, 10.x on a corporate DNS, 192.168.1.1
  # on a home router. Without this exception the firewall silently shoots down the
  # container's own resolver and every lookup times out ("no internet", host DNS
  # apparently ignored). Public egress is already ACCEPTed below, so allowing port
  # 53 to exactly the daemon-assigned resolvers adds no exfiltration channel the
  # agent lacked; it reaches no other LAN port and not the metadata service (:80).
  # The awk guard keeps anything but a bare IPv4 literal out of the rule.
  for ns in $(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { print $2 }' /etc/resolv.conf 2>/dev/null); do
    iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT || die "iptables DNS rule for $ns failed"
    iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT || die "iptables DNS rule for $ns failed"
  done
  for net in $PRIVATE_V4; do iptables -A OUTPUT -d "$net" -j DROP || die "iptables DROP $net failed"; done
  iptables -A OUTPUT -j ACCEPT || die "iptables accept rule failed"
  # Verify the cloud-metadata block actually took. gVisor's netfilter is partial,
  # so a rule can be "accepted" yet not enforced — probe it explicitly.
  iptables -C OUTPUT -d 169.254.0.0/16 -j DROP 2>/dev/null || die "egress firewall did not install (metadata DROP missing) — refusing to run"
  # IPv6, with the same fail-closed stance as the v4 rules above. It used to be
  # best-effort — every rule `|| true`, the whole block skipped when ip6tables was
  # missing — which is the worst shape a security control can take: on a v6-capable
  # host the container kept an unfiltered v6 path to the LAN and to the link-local
  # and ULA metadata addresses, while the v4 rules made it look protected. The
  # trigger is the container HAVING v6 (not ip6tables being installed), because
  # that is the condition under which the gap exists.
  if [ -e /proc/net/if_inet6 ]; then
    command -v ip6tables >/dev/null 2>&1 || die "IPv6 is present but ip6tables is not — refusing to run with unfiltered IPv6 egress"
    ip6tables -F OUTPUT || die "ip6tables flush failed"
    ip6tables -A OUTPUT -o lo -j ACCEPT || die "ip6tables loopback rule failed"
    # Same DNS exception as v4, for hosts whose resolver is an IPv6 ULA/link-local.
    for ns in $(awk '$1 == "nameserver" && $2 ~ /^[0-9a-fA-F:]+$/ { print $2 }' /etc/resolv.conf 2>/dev/null); do
      ip6tables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT || die "ip6tables DNS rule for $ns failed"
      ip6tables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT || die "ip6tables DNS rule for $ns failed"
    done
    for net in ::1/128 fc00::/7 fe80::/10; do ip6tables -A OUTPUT -d "$net" -j DROP || die "ip6tables DROP $net failed"; done
    ip6tables -A OUTPUT -j ACCEPT || die "ip6tables accept rule failed"
    # Verified the same way as v4 metadata: accepted is not enforced.
    ip6tables -C OUTPUT -d fe80::/10 -j DROP 2>/dev/null || die "IPv6 egress firewall did not install (link-local DROP missing) — refusing to run"
  fi
fi
fi

# Drop to the sandbox user (uid/gid 1000) with its normal supplementary groups and
# idle there. setpriv ships in util-linux on the base image. No long-lived Xvfb:
# GUI tools (LibreOffice, wkhtmltopdf) render under an on-demand, throwaway X
# server via the `xvfb-run` shims baked into the image (see Dockerfile.sandbox §8b),
# so we don't burn ~170 MB on a persistent display the typical session never uses.
exec setpriv --reuid=1000 --regid=1000 --init-groups -- sleep infinity
