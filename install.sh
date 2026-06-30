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
# What it does, idempotently: installs Docker (via the official get.docker.com) if
# missing, clones/updates the repo into $CAPKA_DIR, then hands off to
# scripts/up.sh, which generates secrets and brings the stack up on prebuilt
# images. Re-running it upgrades an existing install (git pull + image refresh).
#
# Config via environment:
#   DOMAIN        turnkey HTTPS for this domain (Caddy + Let's Encrypt)
#   PUBLIC_URL    explicit public origin (set behind your own reverse proxy)
#   SETUP_TOKEN   require this token when claiming the admin account (hardening)
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
  setup_privilege
  ensure_git
  ensure_docker
  preflight_disk
  resolve_version
  fetch_repo
  prompt_domain

  # Hand off to up.sh: it owns secret generation and the compose invocation.
  # Pass config explicitly through `env` so it survives the sudo boundary
  # (sudo scrubs the environment by default).
  info "Bringing the stack up ..."
  cd "$CAPKA_DIR"
  $SUDO env \
    ${DOMAIN:+DOMAIN=$DOMAIN} \
    ${PUBLIC_URL:+PUBLIC_URL=$PUBLIC_URL} \
    ${SETUP_TOKEN:+SETUP_TOKEN=$SETUP_TOKEN} \
    ${CAPKA_VERSION:+CAPKA_VERSION=$CAPKA_VERSION} \
    ${CAPKA_BUILD:+CAPKA_BUILD=$CAPKA_BUILD} \
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

ensure_git() {
  have git && return 0
  info "Installing git ..."
  if   have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
  elif have dnf;     then $SUDO dnf install -y -q git
  elif have yum;     then $SUDO yum install -y -q git
  elif have apk;     then $SUDO apk add --no-cache git
  else err "couldn't find a package manager to install git — install it and re-run"
  fi
}

ensure_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    info "Docker present — skipping install."
  else
    info "Installing Docker (via get.docker.com) ..."
    curl -fsSL https://get.docker.com | $SUDO sh
  fi
  # A freshly installed daemon may be down on minimal images; nudge it.
  if have systemctl; then $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; fi
  $SUDO docker version >/dev/null 2>&1 || err "Docker is installed but the daemon isn't reachable — start it and re-run"
}

# The prebuilt stack lands ~8-9 GB of images, plus headroom for Postgres data
# and the per-session sandbox containers. Refuse on a box that clearly can't hold
# it; warn on a tight one. (CAPKA_BUILD or an unpublished arch needs even more.)
preflight_disk() {
  target="$CAPKA_DIR"
  while [ ! -d "$target" ] && [ "$target" != "/" ]; do target=$(dirname "$target"); done
  avail_gb=$(df -Pk "$target" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }')
  [ -n "$avail_gb" ] || return 0   # df unavailable — don't block the install
  if [ "$avail_gb" -lt 10 ]; then
    err "only ${avail_gb} GB free on $target — Capka needs ~10 GB minimum (20+ GB recommended)"
  elif [ "$avail_gb" -lt 20 ]; then
    warn "${avail_gb} GB free on $target — workable, but 20+ GB is recommended (sandbox image alone is ~7.5 GB)"
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
    case "$ip" in
      *.*.*.*) printf '%s' "$ip"; return 0 ;;
    esac
  done
}

# Choose the public origin. With no DOMAIN/PUBLIC_URL we offer a free, zero-setup
# HTTPS hostname derived from the host's public IP: sslip.io resolves
# <ip>.sslip.io → <ip>, so Caddy can fetch a real Let's Encrypt cert without the
# user owning a domain. Interactive runs are prompted (the suggestion is the
# default); piped runs (curl | sh) can't prompt, so they stay on HTTP and we print
# the ready-to-use command.
prompt_domain() {
  DOMAIN="${DOMAIN:-}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  SETUP_TOKEN="${SETUP_TOKEN:-}"
  CAPKA_BUILD="${CAPKA_BUILD:-}"
  if [ -n "$DOMAIN" ] || [ -n "$PUBLIC_URL" ]; then return 0; fi

  ip="$(public_ip)"
  suggested=""
  [ -n "$ip" ] && suggested="$(echo "$ip" | tr '.' '-').sslip.io"

  # `-r /dev/tty` is true even with no controlling terminal (the node exists and
  # is mode-readable), yet the open then fails with ENXIO. Probe the actual open.
  if ( exec </dev/tty ) 2>/dev/null; then
    printf '%s\n' "Domain for automatic HTTPS (blank = the free hostname below, or plain HTTP):" >&2
    [ -n "$suggested" ] && printf '%s\n' "  suggested: $suggested" >&2
    printf '%s' "> " >&2
    read -r DOMAIN </dev/tty || DOMAIN=""
    if [ -z "$DOMAIN" ] && [ -n "$suggested" ]; then
      printf '%s' "Use $suggested for instant HTTPS? [Y/n]: " >&2
      read -r ans </dev/tty || ans=""
      case "$ans" in [Nn]*) ;; *) DOMAIN="$suggested" ;; esac
    fi
  elif [ -n "$suggested" ]; then
    info "No domain set — serving HTTP on :3000. For instant HTTPS, re-run with: DOMAIN=$suggested"
  fi
}

main "$@"
