#!/usr/bin/env sh
# Update an existing Capka install in place. Run it on the host, from anywhere
# inside the checkout (the in-app Settings → Updates page shows this command):
#
#   cd /opt/capka && sudo ./scripts/update.sh
#
# It fetches the newest release tag, checks it out, then hands off to up.sh which
# pulls the matching prebuilt images and recreates the stack. Your .env and data
# are kept.
#
# CAPKA_BRANCH picks a different ref: `stable` tracks the newest release as a
# branch (what a Coolify-style pull deployment should follow), a `vX.Y.Z` tag
# pins one release. A development branch such as `master` needs CAPKA_BUILD=1 —
# images exist only for releases, so its compose has no matching image to pull.
set -eu

# Run from the repo root regardless of where the script is invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# Pick the ref to update to: an explicit CAPKA_BRANCH, else the newest release
# tag, else fall back to master (e.g. before any release is cut).
if [ -z "${CAPKA_BRANCH:-}" ]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || echo)"
  LATEST="$(git ls-remote --tags --refs "$REMOTE" 'v*' 2>/dev/null | awk -F/ '{ print $NF }' | sort -V | tail -n1)"
  CAPKA_BRANCH="${LATEST:-master}"
fi

# Decide the image tag for this ref BEFORE touching the checkout: refusing after
# `git checkout -f` would leave the tree switched to a ref we just declined to
# deploy — the mismatched pair this check exists to prevent, half-applied.
#
# Handling a branch is not "do nothing": leaving a pin from a previous release
# update in place deploys THAT release's images against the branch's newer
# compose — and since the pin is never touched again, it stays wrong forever.
# Every ref therefore states its image tag explicitly.
case "$CAPKA_BRANCH" in
  v*)      TAG="$CAPKA_BRANCH" ;;
  stable)  TAG="latest" ;;  # the branch CI moves to each release; :latest is that same release
  *)
    # A development branch: its compose is newer than any published image, so
    # there is no image tag that matches it. Building from source is the only
    # coherent way to run it — refuse rather than deploy a mismatched pair.
    if [ "${CAPKA_BUILD:-}" != "1" ]; then
      echo "Refusing to update to '$CAPKA_BRANCH' with prebuilt images." >&2
      echo "Images are published on release tags only, so this branch's compose is newer than" >&2
      echo "anything pullable — a service it added may not exist in the image yet." >&2
      echo "Either build from source:   CAPKA_BUILD=1 ./scripts/update.sh" >&2
      echo "or track releases instead:  CAPKA_BRANCH=stable ./scripts/update.sh" >&2
      exit 1
    fi
    TAG="latest"
    ;;
esac

echo "Updating Capka to $CAPKA_BRANCH ..."
git fetch --tags --depth 1 origin "$CAPKA_BRANCH"
# Reset to the target ref (clean, predictable); .env is gitignored and preserved.
git checkout -f FETCH_HEAD >/dev/null 2>&1 || git checkout -f "$CAPKA_BRANCH"

# Hand the tag to up.sh, which owns .env: it persists the pin (rewriting an older
# one) and uses this value for the compose invocation regardless of what is in the
# file. Writing .env from two scripts is how the two get to disagree.
export CAPKA_VERSION="$TAG"

exec sh scripts/up.sh
