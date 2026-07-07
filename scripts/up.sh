#!/usr/bin/env sh
# One command to stand Capka up on a fresh box.
#
# Generates the three required secrets into .env on first run (idempotent — it
# never overwrites an existing value, and self-heals a missing one on upgrade),
# brings the stack up, waits until the app actually answers, then prints the
# address to open. No external account is needed beyond an LLM key, which you add
# in the in-app setup wizard.
#
#   ./scripts/up.sh                 # generate .env (if needed) and start
#   PUBLIC_URL=https://app.example.com ./scripts/up.sh   # set the public origin
#   ./scripts/up.sh --env-only      # only write .env, don't start (CI / inspect)
#
# Re-run it any time to reprint the address, apply .env changes, or upgrade.
set -eu

# Run from the repo root regardless of where the script is invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

ENV_FILE="${CAPKA_ENV_FILE:-.env}"
START=1
for arg in "$@"; do
  case "$arg" in
    --env-only) START=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# 32 random bytes as 64 hex chars — matches the AES-256 master-key format and is
# a strong value for the Postgres password and controller secret too.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Append KEY=<generated> only if KEY is not already defined — preserves operator
# overrides and lets a new required secret self-heal on upgrade.
ensure_secret() {
  key=$1
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$(gen_secret)" >>"$ENV_FILE"
    echo "  generated $key"
  fi
}

# Read a single value out of .env (last wins), stripped of a trailing CR.
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tr -d '\r' | tail -n1; }

# Best-effort public IPv4 so a no-domain install can print a reachable address
# instead of a useless "localhost" (the operator is usually on SSH, not the box).
# install.sh passes CAPKA_PUBLIC_IP; standalone runs probe an external echo.
public_ip() {
  [ -n "${CAPKA_PUBLIC_IP:-}" ] && { printf '%s' "$CAPKA_PUBLIC_IP"; return 0; }
  command -v curl >/dev/null 2>&1 || return 0
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
    if printf '%s' "$ip" | grep -Eq '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
      printf '%s' "$ip"; return 0
    fi
  done
}

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# A .env edited on Windows (WinSCP/Notepad) carries CRLF line endings; the stray
# \r rides along into every value (password, URL) and quietly corrupts auth and
# links. Normalize to LF once, in place, before anything reads the file.
if LC_ALL=C grep -q "$(printf '\r')" "$ENV_FILE" 2>/dev/null; then
  tr -d '\r' <"$ENV_FILE" >"$ENV_FILE.lf" && mv "$ENV_FILE.lf" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  normalized $ENV_FILE line endings (CRLF -> LF)"
fi

echo "Ensuring secrets in $ENV_FILE ..."
ensure_secret POSTGRES_PASSWORD
ensure_secret CONTROLLER_SECRET
ensure_secret CAPKA_MASTER_KEY
# SETUP_TOKEN is intentionally NOT auto-generated: first-run is frictionless by
# default. It's an opt-in hardening for public deploys — set it in .env yourself
# to require it when claiming the admin account (see .env.example).

# Pin the image tag so later runs pull the same version that was installed here
# (the installer passes the release tag it checked out). Compose reads this from
# .env for ${CAPKA_VERSION} substitution; unset → defaults to :latest.
if [ "${CAPKA_VERSION:-}" != "" ] && ! grep -q '^CAPKA_VERSION=' "$ENV_FILE"; then
  printf 'CAPKA_VERSION=%s\n' "$CAPKA_VERSION" >>"$ENV_FILE"
  echo "  pinned CAPKA_VERSION=$CAPKA_VERSION"
fi

# Public origin is optional: unset → Capka derives it from proxy headers. When
# provided (recommended in production), persist it so the value isn't spoofable.
if [ "${PUBLIC_URL:-}" != "" ] && ! grep -q '^PUBLIC_URL=' "$ENV_FILE"; then
  printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL" >>"$ENV_FILE"
  echo "  set PUBLIC_URL=$PUBLIC_URL"
fi

# Optional ACME account email. Persist it so re-runs keep it; when set it turns on
# the Caddy ZeroSSL fallback issuer (see the snippet rendered below).
if [ "${ACME_EMAIL:-}" != "" ] && ! grep -q '^ACME_EMAIL=' "$ENV_FILE"; then
  printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL" >>"$ENV_FILE"
  echo "  set ACME_EMAIL=$ACME_EMAIL"
fi

# Persist the setup token, host port, and bind interface when passed in (the
# installer picks a free port / loopback bind on a shared box). Persisting makes
# the choice sticky: a later bare `up.sh` keeps the same port and reprints the
# working #token setup link instead of silently reverting to defaults.
for var in SETUP_TOKEN PLATFORM_PORT PLATFORM_BIND; do
  eval "val=\${$var:-}"
  if [ "$val" != "" ] && ! grep -q "^${var}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$var" "$val" >>"$ENV_FILE"
    echo "  set $var=$val"
  fi
done

# DOMAIN is the turnkey HTTPS path: persist it and derive PUBLIC_URL=https://DOMAIN
# so auth callbacks and absolute links are correct.
if [ "${DOMAIN:-}" != "" ]; then
  grep -q '^DOMAIN=' "$ENV_FILE" || printf 'DOMAIN=%s\n' "$DOMAIN" >>"$ENV_FILE"
  existing_pub="$(env_value PUBLIC_URL)"
  if [ -z "$existing_pub" ]; then
    printf 'PUBLIC_URL=https://%s\n' "$DOMAIN" >>"$ENV_FILE"
  elif [ "$existing_pub" != "https://$DOMAIN" ]; then
    echo "  WARNING: PUBLIC_URL ($existing_pub) doesn't match DOMAIN ($DOMAIN) — leaving it; fix $ENV_FILE if wrong"
  fi
  echo "  configured HTTPS for $DOMAIN (Caddy will fetch a Let's Encrypt cert)"
fi

if [ "$START" -eq 0 ]; then
  echo "Done (--env-only). Secrets are in $ENV_FILE."
  exit 0
fi

# --- Effective config (honor values just written to .env, not only this run's env) ---
DOMAIN_EFFECTIVE="${DOMAIN:-$(env_value DOMAIN)}"
PUBLIC_URL_EFFECTIVE="${PUBLIC_URL:-$(env_value PUBLIC_URL)}"
ACME_EMAIL_EFFECTIVE="${ACME_EMAIL:-$(env_value ACME_EMAIL)}"
PORT="$(env_value PLATFORM_PORT)"; PORT="${PLATFORM_PORT:-${PORT:-3000}}"
BIND="$(env_value PLATFORM_BIND)"; BIND="${PLATFORM_BIND:-${BIND:-}}"
SETUP_TOKEN_VALUE="$(env_value SETUP_TOKEN)"
BIND_LOOPBACK=""

# Compose file set: the TLS overlay is layered in only when a DOMAIN is configured.
COMPOSE="-f docker-compose.yml"
if [ -n "$DOMAIN_EFFECTIVE" ]; then
  COMPOSE="$COMPOSE -f docker-compose.tls.yml"

  # Render the optional Caddy email snippet (see Caddyfile / docker-compose.tls.yml).
  # The dir must exist for the read-only bind mount either way; the snippet is
  # written only for a valid-looking email, and removed otherwise so toggling
  # ACME_EMAIL off actually takes effect on the next run.
  mkdir -p data/caddy/conf.d
  if printf '%s' "$ACME_EMAIL_EFFECTIVE" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
    printf 'email %s\n' "$ACME_EMAIL_EFFECTIVE" >data/caddy/conf.d/email.caddy
    echo "  ACME email set — ZeroSSL fallback enabled"
  else
    rm -f data/caddy/conf.d/email.caddy
  fi
fi

# The address we'll tell the operator to open. Compute it up front and print it
# now, before the docker output scrolls past — so they know the target even while
# images pull. PLATFORM_BIND matters: a loopback bind (shared box / behind a
# proxy) is NOT reachable at the public IP, so don't advertise one.
if [ -n "$DOMAIN_EFFECTIVE" ]; then
  OPEN_URL="https://$DOMAIN_EFFECTIVE"
elif [ -n "$PUBLIC_URL_EFFECTIVE" ]; then
  OPEN_URL="$PUBLIC_URL_EFFECTIVE"
else
  case "$BIND" in
    127.0.0.1|localhost|::1)
      OPEN_URL="http://127.0.0.1:$PORT"; BIND_LOOPBACK=1 ;;
    *)
      IP="$(public_ip)"
      if [ -n "$IP" ]; then OPEN_URL="http://$IP:$PORT"; else OPEN_URL="http://localhost:$PORT"; fi ;;
  esac
fi

# The link to hand the operator: the #token setup deep-link when SETUP_TOKEN is
# set (fragment stays out of server/proxy logs), else the bare origin. Computed
# once here so every final branch below prints the same working link.
LINK="${OPEN_URL%/}"
[ -n "$SETUP_TOKEN_VALUE" ] && LINK="${OPEN_URL%/}/setup#token=$SETUP_TOKEN_VALUE"

echo
if [ -n "$DOMAIN_EFFECTIVE" ]; then
  echo "Setting up Capka at $OPEN_URL (automatic HTTPS via Caddy) — this takes a few minutes."
elif [ -n "$BIND_LOOPBACK" ]; then
  echo "Setting up Capka on $OPEN_URL (bound to localhost) — this takes a few minutes."
  echo "  NOTE: reachable only via your reverse proxy. Point it at http://127.0.0.1:$PORT,"
  echo "        set PUBLIC_URL=https://your.domain in $ENV_FILE, then re-run scripts/up.sh."
  echo "        From your laptop you can reach it over an SSH tunnel to 127.0.0.1:$PORT."
else
  echo "Setting up Capka at $OPEN_URL — this takes a few minutes."
  if [ -z "$PUBLIC_URL_EFFECTIVE" ]; then
    echo "  NOTE: plain HTTP, no domain. For turnkey HTTPS re-run with DOMAIN=your.domain,"
    echo "        or front it with your own TLS proxy and set PUBLIC_URL."
    echo "        Exposing /setup over plain HTTP? Set SETUP_TOKEN in $ENV_FILE first (see .env.example)."
  fi
fi
echo

# --- Diagnostics helpers ---------------------------------------------------
# docker compose word-splits COMPOSE intentionally (filenames carry no spaces).

# Services that actually failed, in ONE compose call. A container that exited 0
# is a successful one-shot (db-init), NOT a failure; a service not created yet
# isn't listed, so it isn't reported. A container that is running but whose
# healthcheck reports "unhealthy" IS a failure (e.g. a bad master key or a stuck
# migration keeps platform running while /login never answers) — without this it
# would masquerade as "just slow" forever. Everything else running-but-not
# (exited non-zero, restarting, dead) is a real problem. Fields are pipe-
# delimited so an empty Health column can't shift the others under awk.
unhealthy_services() {
  docker compose $COMPOSE ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null | awk -F'|' '
    $2 == "running" && $3 == "unhealthy" { print $1; next }
    $2 == "running" { next }
    $2 == "exited" && $4 == "0" { next }
    { print $1 }'
}

# Has Caddy actually obtained the TLS certificate for $1? Checks the cert file in
# Caddy's data volume from inside the container — a hairpin-NAT-proof positive
# signal that the ACME challenge succeeded, unlike curling our own public IP
# (which can fail on a working setup). Non-zero if the cert is absent OR Caddy
# isn't running (crash-loop) — either way, "HTTPS isn't live yet".
caddy_has_cert() {
  docker compose $COMPOSE exec -T caddy sh -c "ls /data/caddy/certificates/*/$1/$1.crt" >/dev/null 2>&1
}

# Print what went wrong in operator terms: status table, the culprit's last logs,
# and the handful of causes that actually bite on a first install.
diagnose() {
  echo
  echo "Capka didn't come up cleanly. Current status:" >&2
  docker compose $COMPOSE ps >&2 || true
  for svc in $(unhealthy_services); do
    echo >&2
    echo "--- last logs: $svc ---" >&2
    docker compose $COMPOSE logs --tail=40 "$svc" >&2 2>&1 || true
  done
  echo >&2
  echo "Common first-install causes:" >&2
  if [ -n "$DOMAIN_EFFECTIVE" ]; then
    echo "  * Ports 80/443 must be free and open in your provider's firewall (Caddy needs them for the certificate)." >&2
    echo "  * DNS for $DOMAIN_EFFECTIVE must point at THIS server, or the certificate can't be issued." >&2
  fi
  echo "  * Provider firewall/security group may block port $PORT — open it, or put a reverse proxy in front." >&2
  echo "  * Reinstalling over an old database with a fresh password is auto-repaired; a half-initialised" >&2
  echo "    volume is not — if postgres won't start, 'docker compose $COMPOSE down -v' wipes data and starts clean." >&2
  echo "  * Still starting? Re-run this script in a minute to check again: sh scripts/up.sh" >&2
}

# --- Bring the stack up ----------------------------------------------------
# Default: pull the prebuilt GHCR images (fast — no build toolchain on the box).
# The base compose is pull-only, so there is no silent build fallback: to compile
# your own changes or run an unpublished commit, set CAPKA_BUILD=1 — it layers
# docker-compose.build.yml and builds from source instead.
if [ "${CAPKA_BUILD:-}" = "1" ]; then
  COMPOSE="$COMPOSE -f docker-compose.build.yml"
  echo "Building images from source (CAPKA_BUILD=1) — this can take a while ..."
  # The build happens in the single `up --build` below; a separate `build` pass
  # here would just compile everything twice.
else
  echo "Pulling images ..."
  docker compose $COMPOSE pull --ignore-pull-failures || true
  # The ~7.5 GB sandbox execution image isn't a compose service on the pull path,
  # so it isn't fetched here — the controller pulls it in the BACKGROUND on boot
  # (see sandbox-controller/server.js). The app is usable immediately; only the
  # first sandbox tool call may wait for that download to finish.
fi

# Bring the whole stack up. Compose ordering starts Postgres first, then the
# db-init one-shot re-syncs the DB role password to POSTGRES_PASSWORD (heals a
# reinstall/rotation over an existing volume — see docker-compose.yml), then the
# app. --remove-orphans clears a container left by a previous layout (e.g. a
# `caddy` after switching away from DOMAIN); it touches no named volume or ./data.
# NOTE: it also removes containers from overlays NOT passed on this command line
# — including the pg-backup sidecar from docker-compose.backup.yml. If you run
# that overlay, bring it up in the SAME command (add -f docker-compose.backup.yml)
# so re-running this script doesn't silently tear the backup job down.
# On failure (e.g. a host port already taken — including the TLS loopback rescue
# publish), `set -e` would abort before diagnostics; route through diagnose().
echo "Starting the stack ..."
if [ "${CAPKA_BUILD:-}" = "1" ]; then
  docker compose $COMPOSE up -d --build --remove-orphans || { diagnose; exit 1; }
else
  docker compose $COMPOSE up -d --remove-orphans || { diagnose; exit 1; }
fi

# --- Wait until the app is healthy, then print the address -----------------
# Poll the platform's container HEALTH (its healthcheck already probes /login
# every 15s). Reading health instead of curling a host port is independent of
# DNS/TLS and of PLATFORM_BIND/PORT, so it can't false-negative on a loopback or
# custom-interface bind, and needs no curl/wget on the host.
READY=0
echo "Waiting for Capka to come up ..."
i=0
while [ "$i" -lt 60 ]; do
  line="$(docker compose $COMPOSE ps -a --format '{{.Service}} {{.State}} {{.Health}}' platform 2>/dev/null | head -1)"
  case "$line" in
    *" unhealthy") break ;;         # healthcheck ran and keeps failing — stop, diagnose (don't wait it out)
    *" healthy") READY=1; break ;;
    *" running "*|*" running") ;;   # up, health still starting — keep waiting
    "") ;;                          # not created yet — keep waiting
    *) break ;;                     # exited/restarting — stop; diagnose explains
  esac
  i=$((i + 1)); sleep 3
done

echo
if [ "$READY" -eq 1 ]; then
  # The platform is healthy — but on the HTTPS path the site is only truly
  # reachable once Caddy has the certificate, which silently fails when inbound
  # 80/443 are firewalled (a shared/cloud footgun the port probe can't see). So
  # don't promise HTTPS until the cert exists: wait briefly, then tell the truth.
  cert_ok=""
  if [ -n "$DOMAIN_EFFECTIVE" ]; then
    echo "  Waiting for the HTTPS certificate ..."
    k=0
    while [ "$k" -lt 20 ]; do
      if caddy_has_cert "$DOMAIN_EFFECTIVE"; then cert_ok=1; break; fi
      k=$((k + 1)); sleep 3
    done
  fi
  # Prominent, un-missable final block.
  echo "  ────────────────────────────────────────────────"
  echo "   Capka is up. Open:"
  echo "     $LINK"
  echo "  ────────────────────────────────────────────────"
  if [ -n "$DOMAIN_EFFECTIVE" ] && [ -z "$cert_ok" ]; then
    echo "  NOTE: the TLS certificate isn't issued yet — $LINK may not load until it is."
    echo "  Let's Encrypt validates over port 80, so if it doesn't come up in a minute, check:"
    echo "    * ports 80 AND 443 are open in your host firewall (ufw/firewalld) AND your cloud/provider firewall"
    echo "    * DNS for $DOMAIN_EFFECTIVE points at THIS server"
    echo "    * then read the reason:  docker compose $COMPOSE logs caddy"
    echo "  Reach it locally meanwhile (SSH tunnel):  http://127.0.0.1:$PORT"
  elif [ -n "$DOMAIN_EFFECTIVE" ]; then
    echo "  (Certificate issued — HTTPS is live.)"
  fi
  echo "  Lost this address later? Run:  cd \"$(pwd)\" && sh scripts/up.sh"
elif [ -n "$(unhealthy_services)" ]; then
  # A service actually failed (not just slow) — show why, then repeat the link.
  diagnose
  echo >&2
  echo "  Once fixed, open:  $LINK" >&2
  exit 1
else
  # Everything is running but not healthy within the window — almost always just
  # a slow first boot (migrations + warm-up). Don't cry wolf.
  echo "  Capka is starting but isn't ready yet — give it another minute, then open:"
  echo "    $LINK"
  echo "  Check status any time with:  docker compose $COMPOSE ps"
  echo "  Re-run to check again:  sh scripts/up.sh"
fi
