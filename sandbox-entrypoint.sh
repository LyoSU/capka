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
  PRIVATE_V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 192.0.0.0/24 198.18.0.0/15"
  iptables -F OUTPUT || die "iptables flush failed"
  iptables -A OUTPUT -o lo -j ACCEPT || die "iptables loopback rule failed"
  for net in $PRIVATE_V4; do iptables -A OUTPUT -d "$net" -j DROP || die "iptables DROP $net failed"; done
  iptables -A OUTPUT -j ACCEPT || die "iptables accept rule failed"
  # Verify the cloud-metadata block actually took. gVisor's netfilter is partial,
  # so a rule can be "accepted" yet not enforced — probe it explicitly.
  iptables -C OUTPUT -d 169.254.0.0/16 -j DROP 2>/dev/null || die "egress firewall did not install (metadata DROP missing) — refusing to run"
  # IPv6 best-effort: drop private/link-local when the stack is present. (Public
  # IPv6 egress without these rules is the residual gap; v4 metadata is the must-have.)
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -F OUTPUT 2>/dev/null || true
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    for net in ::1/128 fc00::/7 fe80::/10; do ip6tables -A OUTPUT -d "$net" -j DROP 2>/dev/null || true; done
    ip6tables -A OUTPUT -j ACCEPT 2>/dev/null || true
  fi
fi

# Drop to the sandbox user (uid/gid 1000) with its normal supplementary groups and
# idle there. setpriv ships in util-linux on the base image. No long-lived Xvfb:
# GUI tools (LibreOffice, wkhtmltopdf) render under an on-demand, throwaway X
# server via the `xvfb-run` shims baked into the image (see Dockerfile.sandbox §8b),
# so we don't burn ~170 MB on a persistent display the typical session never uses.
exec setpriv --reuid=1000 --regid=1000 --init-groups -- sleep infinity
