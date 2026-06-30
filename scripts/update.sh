#!/usr/bin/env sh
# Update an existing Capka install in place. Run it on the host, from anywhere
# inside the checkout (the in-app Settings → Updates page shows this command):
#
#   cd /opt/capka && sudo ./scripts/update.sh
#
# It fetches the newest release tag (or set CAPKA_BRANCH=master for the
# development tip), checks it out, then hands off to up.sh which pulls the
# matching prebuilt images and recreates the stack. Your .env and data are kept.
set -eu

# Run from the repo root regardless of where the script is invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

ENV_FILE="${CAPKA_ENV_FILE:-.env}"

# Pick the ref to update to: an explicit CAPKA_BRANCH, else the newest release
# tag, else fall back to master (e.g. before any release is cut).
if [ -z "${CAPKA_BRANCH:-}" ]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || echo)"
  LATEST="$(git ls-remote --tags --refs "$REMOTE" 'v*' 2>/dev/null | awk -F/ '{ print $NF }' | sort -V | tail -n1)"
  CAPKA_BRANCH="${LATEST:-master}"
fi

echo "Updating Capka to $CAPKA_BRANCH ..."
git fetch --tags --depth 1 origin "$CAPKA_BRANCH"
# Reset to the target ref (clean, predictable); .env is gitignored and preserved.
git checkout -f FETCH_HEAD >/dev/null 2>&1 || git checkout -f "$CAPKA_BRANCH"

# Pin the image tag to match the checked-out code (a release tag → that tag;
# master → :latest). up.sh only *adds* a missing pin, so on an upgrade we rewrite
# any existing one here, then export it so this run's compose uses it regardless.
case "$CAPKA_BRANCH" in
  v*)
    if grep -q '^CAPKA_VERSION=' "$ENV_FILE" 2>/dev/null; then
      sed -i.bak "s|^CAPKA_VERSION=.*|CAPKA_VERSION=$CAPKA_BRANCH|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    fi
    export CAPKA_VERSION="$CAPKA_BRANCH"
    ;;
esac

exec sh scripts/up.sh
