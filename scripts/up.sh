#!/usr/bin/env sh
# One command to stand unClaw up on a fresh box.
#
# Generates the three required secrets into .env on first run (idempotent — it
# never overwrites an existing value, and self-heals a missing one on upgrade),
# then brings the stack up. No external account is needed beyond an LLM key,
# which you add in the in-app setup wizard.
#
#   ./scripts/up.sh                 # generate .env (if needed) and start
#   PUBLIC_URL=https://app.example.com ./scripts/up.sh   # set the public origin
#   ./scripts/up.sh --env-only      # only write .env, don't start (CI / inspect)
set -eu

# Run from the repo root regardless of where the script is invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

ENV_FILE="${UNCLAW_ENV_FILE:-.env}"
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

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Ensuring secrets in $ENV_FILE ..."
ensure_secret POSTGRES_PASSWORD
ensure_secret CONTROLLER_SECRET
ensure_secret UNCLAW_MASTER_KEY

# Public origin is optional: unset → unClaw derives it from proxy headers. When
# provided (recommended in production), persist it so the value isn't spoofable.
if [ "${PUBLIC_URL:-}" != "" ] && ! grep -q '^PUBLIC_URL=' "$ENV_FILE"; then
  printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL" >>"$ENV_FILE"
  echo "  set PUBLIC_URL=$PUBLIC_URL"
fi

if [ "$START" -eq 0 ]; then
  echo "Done (--env-only). Secrets are in $ENV_FILE."
  exit 0
fi

echo "Starting unClaw (docker compose up --build -d) ..."
docker compose up --build -d

echo
echo "unClaw is starting. Open ${PUBLIC_URL:-http://localhost:3000} and finish setup."
