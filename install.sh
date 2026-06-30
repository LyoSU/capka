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
#   CAPKA_BRANCH  git branch                 (default: master)
#   CAPKA_BUILD=1 compile from source instead of pulling prebuilt images
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

fetch_repo() {
  if [ -d "$CAPKA_DIR/.git" ]; then
    info "Updating existing install at $CAPKA_DIR ..."
    $SUDO git -C "$CAPKA_DIR" pull --ff-only
  else
    [ -e "$CAPKA_DIR" ] && err "$CAPKA_DIR exists but isn't a git checkout — remove it or set CAPKA_DIR"
    info "Cloning Capka into $CAPKA_DIR ..."
    $SUDO git clone --depth 1 --branch "$CAPKA_BRANCH" "$CAPKA_REPO" "$CAPKA_DIR"
  fi
}

# When piped (curl | sh) stdin is the script, so an interactive prompt must read
# from the controlling terminal. Skip silently if there's no tty or the origin
# was already chosen — the no-DOMAIN path just serves HTTP on :3000.
prompt_domain() {
  DOMAIN="${DOMAIN:-}"
  PUBLIC_URL="${PUBLIC_URL:-}"
  SETUP_TOKEN="${SETUP_TOKEN:-}"
  CAPKA_BUILD="${CAPKA_BUILD:-}"
  if [ -n "$DOMAIN" ] || [ -n "$PUBLIC_URL" ]; then return 0; fi
  if [ ! -r /dev/tty ]; then return 0; fi
  printf '%s\n' "Domain for automatic HTTPS, e.g. capka.example.com" >&2
  printf '%s' "(leave blank to serve plain HTTP on :3000): " >&2
  read -r DOMAIN </dev/tty || DOMAIN=""
}

main "$@"
