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
if [ "${SANDBOX_EGRESS_FILTER:-0}" = "1" ] && command -v iptables >/dev/null 2>&1; then
  PRIVATE_V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 192.0.0.0/24 198.18.0.0/15"
  iptables -F OUTPUT 2>/dev/null || true
  iptables -A OUTPUT -o lo -j ACCEPT
  for net in $PRIVATE_V4; do iptables -A OUTPUT -d "$net" -j DROP; done
  iptables -A OUTPUT -j ACCEPT
  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -F OUTPUT 2>/dev/null || true
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    for net in ::1/128 fc00::/7 fe80::/10; do ip6tables -A OUTPUT -d "$net" -j DROP 2>/dev/null || true; done
    ip6tables -A OUTPUT -j ACCEPT 2>/dev/null || true
  fi
fi

# Drop to the sandbox user (uid/gid 1000) with its normal supplementary groups and
# run the long-lived processes there. setpriv ships in util-linux on the base image.
exec setpriv --reuid=1000 --regid=1000 --init-groups -- /bin/bash -c '
  # Virtual display for headless rendering (LibreOffice, wkhtmltopdf, Playwright)
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
  sleep 0.5
  exec sleep infinity
'
