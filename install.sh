#!/bin/sh
# Capka one-command installer — stands the full stack up on a fresh Linux box.
#
#   curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh | DOMAIN=capka.example.com sh
#
# Prefer to read before you run (good practice for any curl|sh):
#   curl -fsSL https://raw.githubusercontent.com/LyoSU/capka/master/install.sh -o install.sh
#   less install.sh && sh install.sh
#
# What it does, idempotently: checks the box can hold the stack, installs Docker
# (via the official get.docker.com) if missing, clones/updates the repo into
# $CAPKA_DIR, then hands off to scripts/up.sh, which generates secrets and brings
# the stack up on prebuilt images. Re-running it upgrades an existing install
# (git pull + image refresh).
#
# It adapts to the box: on a server that already runs a web proxy it stays off
# ports 80/443 and prints how to front it; if port 3000 is taken it picks a free
# one. It never reinstalls Docker over a daemon that's already running other
# containers.
#
# Config via environment:
#   DOMAIN        turnkey HTTPS for this domain (Caddy + Let's Encrypt)
#   PUBLIC_URL    explicit public origin (set behind your own reverse proxy)
#   SETUP_TOKEN   require this token when claiming the admin account (hardening)
#   ACME_EMAIL    ACME account email (enables the ZeroSSL cert fallback)
#   CAPKA_DIR     install location           (default: /opt/capka)
#   CAPKA_REPO    git remote                 (default: https://github.com/LyoSU/capka.git)
#   CAPKA_BRANCH  git ref to install         (default: newest release tag, else master)
#   CAPKA_VERSION image tag to pull          (default: matches the installed ref)
#   CAPKA_BUILD=1 compile from source instead of pulling prebuilt images
#
# Re-running upgrades in place: it resets the checkout to the target ref (your
# .env config is gitignored and preserved, but local edits to tracked files are
# discarded).
set -eu

# The whole installer lives in main() and is only invoked on the last line. If
# the download is truncated mid-flight (dropped connection while piping to sh),
# the partial script defines functions but never runs them — nothing executes.
main() {
  CAPKA_DIR="${CAPKA_DIR:-/opt/capka}"
  CAPKA_REPO="${CAPKA_REPO:-https://github.com/LyoSU/capka.git}"
  CAPKA_BRANCH="${CAPKA_BRANCH:-master}"

  setup_colors
  banner

  require_linux
  preflight_ram
  setup_privilege
  ensure_prereqs
  ensure_docker
  detect_docker_caveats
  preflight_disk
  resolve_version
  fetch_repo
  choose_access

  # Hand off to up.sh: it owns secret generation and the compose invocation.
  # Pass config explicitly through `env` so it survives the sudo boundary
  # (sudo scrubs the environment by default).
  info "Bringing the stack up ..."
  cd "$CAPKA_DIR"
  $SUDO env \
    ${DOMAIN:+DOMAIN=$DOMAIN} \
    ${PUBLIC_URL:+PUBLIC_URL=$PUBLIC_URL} \
    ${SETUP_TOKEN:+SETUP_TOKEN=$SETUP_TOKEN} \
    ${ACME_EMAIL:+ACME_EMAIL=$ACME_EMAIL} \
    ${CAPKA_VERSION:+CAPKA_VERSION=$CAPKA_VERSION} \
    ${CAPKA_BUILD:+CAPKA_BUILD=$CAPKA_BUILD} \
    ${PLATFORM_PORT:+PLATFORM_PORT=$PLATFORM_PORT} \
    ${PLATFORM_BIND:+PLATFORM_BIND=$PLATFORM_BIND} \
    ${PUBLIC_IP:+CAPKA_PUBLIC_IP=$PUBLIC_IP} \
    sh scripts/up.sh
}

# ---- helpers ---------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

setup_colors() {
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
    RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"
  else
    BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
  fi
}

info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$1" >&2; }
warn() { printf '%swarning:%s %s\n' "$RED" "$RESET" "$1" >&2; }
err()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

banner() {
  printf '%s\n' "${BOLD}Capka installer${RESET}" >&2
  printf '%s\n' "${DIM}This will install Docker (if needed), clone Capka into ${CAPKA_DIR}," >&2
  printf '%s\n\n' "and start the stack. Ctrl-C now to abort.${RESET}" >&2
}

require_linux() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin) err "macOS isn't a deployment target — for local dev run: npm run docker:dev" ;;
    *) err "unsupported OS '$(uname -s)' — Capka self-hosts on Linux" ;;
  esac
}

# Fail fast on a box that can't hold the stack: the platform build/runtime and
# sandboxes need real memory. Swap counts toward the floor (slow but survives).
preflight_ram() {
  kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || true)
  [ -n "${kb:-}" ] || return 0
  mb=$((kb / 1024))
  swkb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
  swmb=$(( ${swkb:-0} / 1024 ))
  if [ "$mb" -lt 1900 ] && [ $((mb + swmb)) -lt 1900 ]; then
    err "only ${mb} MB RAM (+${swmb} MB swap) — Capka needs ~2 GB. Add RAM, or create a swap file: https://docs.docker.com (search 'add swap')."
  elif [ "$mb" -lt 3800 ]; then
    warn "${mb} MB RAM — workable, but 4 GB+ is recommended (large document jobs and gVisor need headroom)."
  fi
}

# Root is needed to install Docker and write to /opt. If we're not root, lean on
# sudo; if sudo isn't available either, fail with a clear instruction.
setup_privilege() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif have sudo; then
    SUDO="sudo"
    info "Not running as root — privileged steps will use sudo."
  else
    err "run as root, or install sudo (this needs to install Docker and write to $CAPKA_DIR)"
  fi
}

# git and curl are both needed below (curl fetches Docker's installer and probes
# the public IP). The script itself may have arrived via wget, so don't assume curl.
ensure_prereqs() {
  need=""
  have git  || need="$need git"
  have curl || need="$need curl"
  [ -n "$need" ] || return 0
  info "Installing:$need ..."
  if   have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq $need
  elif have dnf;     then $SUDO dnf install -y -q $need
  elif have yum;     then $SUDO yum install -y -q $need
  elif have apk;     then $SUDO apk add --no-cache $need
  else err "couldn't find a package manager to install:$need — install them and re-run"
  fi
}

# Run the official Docker installer, but keep its very noisy apt/kernel/version
# output out of the operator's face — a wall of `+ sh -c ...` lines looks alarming
# to a non-technical user. Show one calm line; on failure, surface the log tail.
install_docker_quietly() {
  log=/tmp/capka-docker-install.log
  info "$1 — this takes a minute ..."
  if ! curl -fsSL https://get.docker.com | $SUDO sh >"$log" 2>&1; then
    tail -20 "$log" >&2
    err "Docker install failed — full log at $log"
  fi
}

ensure_docker() {
  # Reject podman aliased as `docker`: it doesn't expose the container/exec socket
  # API the sandbox controller drives, and get.docker.com won't change that.
  if have docker && docker --version 2>/dev/null | grep -qi podman; then
    err "found podman aliased as 'docker' — Capka needs the real Docker Engine + compose plugin. Install docker-ce (https://docs.docker.com/engine/install/) and re-run."
  fi

  if have docker && docker compose version >/dev/null 2>&1; then
    info "Docker present — skipping install."
  elif have docker; then
    # Docker present but no compose plugin. Reinstalling can restart the daemon
    # and disrupt other containers, so only auto-install on a box that isn't
    # already running any; otherwise tell the operator to add just the plugin.
    running=$($SUDO docker ps -q 2>/dev/null | wc -l | tr -d ' ')
    if [ "${running:-0}" -gt 0 ]; then
      err "Docker is running ${running} container(s) but the 'docker compose' plugin is missing. Add it without disrupting your daemon (https://docs.docker.com/compose/install/linux/) and re-run."
    fi
    install_docker_quietly "Adding the docker compose plugin"
  else
    # get.docker.com's convenience script doesn't support Alpine.
    if have apk && ! have apt-get && ! have dnf && ! have yum; then
      err "on Alpine install Docker with: apk add docker docker-cli-compose && rc-update add docker && service docker start — then re-run."
    fi
    install_docker_quietly "Installing Docker"
  fi

  # A freshly installed daemon may be down on minimal images; nudge it.
  if have systemctl; then $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; fi
  $SUDO docker version >/dev/null 2>&1 || err "Docker is installed but the daemon isn't reachable — start it and re-run"
  ensure_compose_version
}

# The compose files use override tags (!override / !reset) that need Compose
# v2.24+. An older plugin fails with a cryptic YAML error instead — gate here.
ensure_compose_version() {
  v=$($SUDO docker compose version --short 2>/dev/null | tr -dc '0-9.')
  maj=${v%%.*}; case "$maj" in ''|*[!0-9]*) return 0 ;; esac   # unknown format — don't block
  rest=${v#*.}; min=${rest%%.*}; case "$min" in ''|*[!0-9]*) min=0 ;; esac
  if [ "$maj" -lt 2 ] || { [ "$maj" -eq 2 ] && [ "$min" -lt 24 ]; }; then
    err "docker compose v$v is too old — Capka needs v2.24+. Update the compose plugin (https://docs.docker.com/compose/install/linux/) and re-run."
  fi
}

# Non-fatal warnings for Docker setups where the socket/bind-mount model the
# sandbox relies on may not hold. We warn rather than refuse: advanced operators
# may have configured around it.
detect_docker_caveats() {
  case "$(command -v docker)" in
    */snap/*) warn "Docker looks installed via snap; its confinement can block bind mounts under $CAPKA_DIR. If sandboxes fail to start, install Docker from docs.docker.com instead." ;;
  esac
  if $SUDO docker info --format '{{println .SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    warn "rootless Docker detected. The sandbox controller mounts /var/run/docker.sock; rootless exposes the socket elsewhere, so sandboxes may not start without extra setup (see SECURITY.md)."
  fi
}

# The prebuilt stack lands ~8-9 GB of images, plus headroom for Postgres data
# and the per-session sandbox containers. Check the filesystem the DAEMON stores
# images on (often a different mount than $CAPKA_DIR), and refuse a box that
# clearly can't hold it. (CAPKA_BUILD or an unpublished arch needs even more.)
preflight_disk() {
  ddir=$($SUDO docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "${ddir:-}" ] && [ -d "$ddir" ] || ddir=/var/lib/docker
  [ -d "$ddir" ] || ddir=/var/lib
  avail_gb=$(df -Pk "$ddir" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }')
  [ -n "$avail_gb" ] || return 0   # df unavailable — don't block the install
  if [ "$avail_gb" -lt 15 ]; then
    err "only ${avail_gb} GB free on $ddir (Docker's image store) — Capka needs ~15 GB minimum; the sandbox image alone unpacks to ~7.5 GB (20+ GB recommended)."
  elif [ "$avail_gb" -lt 20 ]; then
    warn "${avail_gb} GB free on $ddir — workable, but 20+ GB gives comfortable headroom for images, data, and sandboxes."
  fi
}

# Keep the cloned code and the pulled images on the same version: install the
# newest published release tag by default. Skipped if the operator pinned a
# version or a non-default branch — then they've explicitly chosen what to run.
resolve_version() {
  CAPKA_VERSION="${CAPKA_VERSION:-}"
  if [ -n "$CAPKA_VERSION" ] || [ "$CAPKA_BRANCH" != "master" ]; then return 0; fi
  latest=$(git ls-remote --tags --refs "$CAPKA_REPO" 'v*' 2>/dev/null \
    | awk -F/ '{ print $NF }' | sort -V | tail -n1)
  if [ -n "$latest" ]; then
    info "Newest release is $latest — installing it (set CAPKA_BRANCH=master for the development tip)."
    CAPKA_BRANCH="$latest"
    CAPKA_VERSION="$latest"
  else
    info "No tagged release yet — installing the development tip (master + :latest images)."
  fi
}

fetch_repo() {
  if [ -d "$CAPKA_DIR/.git" ]; then
    info "Updating $CAPKA_DIR to $CAPKA_BRANCH ..."
    $SUDO git -C "$CAPKA_DIR" fetch --tags --depth 1 origin "$CAPKA_BRANCH" 2>/dev/null \
      || err "couldn't fetch '$CAPKA_BRANCH' from $CAPKA_REPO — check network and the ref name"
    # checkout -f resets to the target ref (clean, predictable upgrade); .env is
    # gitignored so config survives, but edits to tracked files are discarded.
    $SUDO git -C "$CAPKA_DIR" checkout -f FETCH_HEAD >/dev/null 2>&1 \
      || err "couldn't switch $CAPKA_DIR to '$CAPKA_BRANCH'"
  else
    [ -e "$CAPKA_DIR" ] && err "$CAPKA_DIR exists but isn't a git checkout — remove it or set CAPKA_DIR"
    info "Cloning Capka ($CAPKA_BRANCH) into $CAPKA_DIR ..."
    $SUDO git clone --depth 1 --branch "$CAPKA_BRANCH" "$CAPKA_REPO" "$CAPKA_DIR"
  fi
}

# Best-effort public IPv4, via an external echo service (the box already has
# egress — it just installed Docker / pulled images). Empty if every probe fails.
public_ip() {
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
    # Strict IPv4 only — the value becomes a hostname we hand to Caddy and the
    # compose env, so reject anything a compromised echo service could smuggle in
    # (whitespace, shell metacharacters), not just "has dots".
    if printf '%s' "$ip" | grep -Eq '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
      printf '%s' "$ip"; return 0
    fi
  done
}

# Is a TCP port already listened on? Best-effort via ss/netstat; if neither
# exists we can't tell, so assume free (don't block the install on a probe gap).
port_busy() {
  p=$1
  if have ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}\$"
  elif have netstat; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}\$"
  else
    return 1
  fi
}

# On the turnkey-HTTPS path, Caddy needs inbound 80/443 for the Let's Encrypt
# challenge; an active host firewall (ufw/firewalld) that hasn't allowed them
# makes the certificate silently never issue — the top "it just won't open"
# footgun. Since the installer already runs as root to stand up a public web
# server, open exactly those two ports (idempotent, trivially reverted) and say
# so. Escape hatch: CAPKA_NO_FIREWALL=1 to manage the firewall yourself. A raw
# iptables setup is left untouched (too risky to edit blind), and a cloud/
# provider firewall is a separate layer this can't reach — up.sh's post-boot
# certificate check catches both of those.
ensure_firewall_open() {
  [ "${CAPKA_NO_FIREWALL:-}" = "1" ] && return 0
  if have ufw && $SUDO ufw status 2>/dev/null | grep -qi '^Status: active'; then
    $SUDO ufw allow 80/tcp  >/dev/null 2>&1 || true
    $SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
    info "Opened ports 80 and 443 in ufw (needed for HTTPS). Undo: sudo ufw delete allow 80/tcp && sudo ufw delete allow 443/tcp"
  elif have firewall-cmd && $SUDO firewall-cmd --state 2>/dev/null | grep -qi running; then
    $SUDO firewall-cmd --add-service=http --add-service=https --permanent >/dev/null 2>&1 || true
    $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
    info "Opened http/https in firewalld (needed for HTTPS). Undo: sudo firewall-cmd --remove-service=http --remove-service=https --permanent && sudo firewall-cmd --reload"
  fi
}

# Decide how the app is reached, adapting to what's already on the box:
#  - something on 80/443 ⇒ an existing proxy; stay off those ports, bind loopback,
#    and print how to front Capka with it (no Caddy, no sslip offer).
#  - app port taken ⇒ pick a free one.
#  - otherwise offer turnkey HTTPS with a friendly prompt (free sslip.io default).
# Sets globals consumed by main()'s handoff: DOMAIN, PUBLIC_URL, PLATFORM_PORT,
# PLATFORM_BIND, PUBLIC_IP.
choose_access() {
  DOMAIN="${DOMAIN:-}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  SETUP_TOKEN="${SETUP_TOKEN:-}"
  ACME_EMAIL="${ACME_EMAIL:-}"
  CAPKA_BUILD="${CAPKA_BUILD:-}"
  PLATFORM_PORT="${PLATFORM_PORT:-}"
  PLATFORM_BIND="${PLATFORM_BIND:-}"

  # Existing install (upgrade / re-run): keep the persisted config. Probing ports
  # here would flag Capka's OWN listeners as conflicts (its platform on 3000, its
  # Caddy on 80/443) and mangle a working setup. up.sh reads DOMAIN/PORT/BIND from
  # .env; any value the operator explicitly passed this run is still honored.
  # (Return BEFORE probing the public IP — that's a network round-trip we'd
  # otherwise pay on every upgrade for a value a re-run doesn't need.)
  if [ -f "$CAPKA_DIR/.env" ]; then
    info "Existing install detected — keeping your configuration (pass DOMAIN=… to change it)."
    return 0
  fi

  PUBLIC_IP="$(public_ip 2>/dev/null || true)"

  existing_proxy=""
  if port_busy 80 || port_busy 443; then existing_proxy=1; fi

  # Pick a free app port if the wanted one is taken.
  want="${PLATFORM_PORT:-3000}"
  if port_busy "$want"; then
    for p in 3000 3100 3200 8080 8090 8300 8800; do
      port_busy "$p" || { new_port="$p"; break; }
    done
    warn "port $want is already in use — Capka will use ${new_port:-$want} instead."
    want="${new_port:-$want}"
  fi
  PLATFORM_PORT="$want"

  # On a shared box, bind the app to loopback so it doesn't fight the existing
  # proxy or get published past a host firewall.
  if [ -n "$existing_proxy" ] && [ -z "$PLATFORM_BIND" ]; then PLATFORM_BIND="127.0.0.1"; fi

  # A domain was requested but 80/443 are already taken → Caddy can't bind them,
  # so turnkey HTTPS is impossible on this box. Don't start a crash-looping Caddy
  # on a cert that can never issue: fall back to reverse-proxy mode (serve on
  # loopback; the existing proxy terminates TLS for the domain) and explain it.
  if [ -n "$existing_proxy" ] && [ -n "$DOMAIN" ]; then
    warn "ports 80/443 are already in use — can't run built-in HTTPS for $DOMAIN on this box."
    [ -z "$PUBLIC_URL" ] && PUBLIC_URL="https://$DOMAIN"
    DOMAIN=""
    cat >&2 <<EOF
  Capka will listen on http://127.0.0.1:$PLATFORM_PORT. Point your existing web
  server at it and terminate TLS there:
    * add a vhost for ${PUBLIC_URL#https://} proxying to http://127.0.0.1:$PLATFORM_PORT
    * PUBLIC_URL=$PUBLIC_URL will be written to $CAPKA_DIR/.env
  See docs/DEPLOY.md (host-nginx runbook) for a full example.
EOF
    return 0
  fi

  # Origin already chosen by the operator (own domain via Caddy, or explicit
  # PUBLIC_URL behind their own proxy) → up.sh handles DOMAIN/PUBLIC_URL. On the
  # Caddy path (DOMAIN set, nothing already on 80/443) make sure the host firewall
  # lets the ACME challenge through.
  if [ -n "$DOMAIN" ] || [ -n "$PUBLIC_URL" ]; then
    [ -n "$DOMAIN" ] && [ -z "$existing_proxy" ] && ensure_firewall_open
    return 0
  fi

  # Existing web server on 80/443 → can't run Caddy there; guide them to front it.
  if [ -n "$existing_proxy" ]; then
    info "Detected a web server already on port 80/443 — skipping built-in HTTPS."
    cat >&2 <<EOF
  This box already serves web traffic, so Capka will listen on
  http://127.0.0.1:$PLATFORM_PORT and you point your existing proxy at it:
    * add a vhost proxying your domain to http://127.0.0.1:$PLATFORM_PORT
    * then set PUBLIC_URL=https://your.domain in $CAPKA_DIR/.env and re-run:
        cd $CAPKA_DIR && sudo ./scripts/up.sh
  See docs/DEPLOY.md (host-nginx runbook) for a full example.
EOF
    return 0
  fi

  # Clean box: offer turnkey HTTPS. sslip.io resolves <ip>.sslip.io → <ip>, so
  # Caddy can fetch a real Let's Encrypt cert with no domain of your own.
  suggested=""
  [ -n "$PUBLIC_IP" ] && suggested="$(echo "$PUBLIC_IP" | tr '.' '-').sslip.io"

  # `-r /dev/tty` is true even with no controlling terminal (the node exists and
  # is mode-readable), yet the open then fails with ENXIO. Probe the actual open.
  if ( exec </dev/tty ) 2>/dev/null; then
    printf '\n%s\n' "How should people reach Capka?" >&2
    printf '%s\n' "  • Have a domain? Type it — we'll set up HTTPS automatically." >&2
    if [ -n "$suggested" ]; then
      printf '%s\n' "  • No domain? Just press Enter — you get a free HTTPS address with a padlock:" >&2
      printf '%s\n' "      https://$suggested" >&2
    fi
    # Escape hatch: plain HTTP, for when ports 80/443 are blocked upstream (a
    # firewall this probe can't see) and automatic HTTPS would just hang on a
    # certificate that never issues.
    printf '%s\n' "  • Just want plain HTTP for now? Type: http" >&2
    printf '%s' "Domain (Enter = free HTTPS, 'http' = no cert): " >&2
    read -r DOMAIN </dev/tty || DOMAIN=""
    case "$DOMAIN" in
      http|HTTP|https|none|no|plain)
        DOMAIN=""
        info "OK — plain HTTP on port $PLATFORM_PORT (no certificate). Set PUBLIC_URL later if you put it behind a proxy." ;;
      "")
        if [ -n "$suggested" ]; then DOMAIN="$suggested"; info "Great — using $suggested for instant HTTPS."; fi ;;
    esac
    # Turnkey HTTPS chosen (typed domain or sslip) → open the firewall so Caddy
    # can complete the ACME challenge. (No existing proxy on this path — those
    # cases returned above.)
    [ -n "$DOMAIN" ] && ensure_firewall_open
  elif [ -n "$suggested" ]; then
    info "No domain set — serving HTTP on :$PLATFORM_PORT. For instant HTTPS, re-run with: DOMAIN=$suggested"
  fi
}

main "$@"
