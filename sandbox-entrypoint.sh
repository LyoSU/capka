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

# Drop to the sandbox user (uid/gid 1000) with its normal supplementary groups and
# run the long-lived processes there. setpriv ships in util-linux on the base image.
exec setpriv --reuid=1000 --regid=1000 --init-groups -- /bin/bash -c '
  # Virtual display for headless rendering (LibreOffice, wkhtmltopdf, Playwright)
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
  sleep 0.5
  exec sleep infinity
'
