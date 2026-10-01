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
#
# It stays on the installed major version: with no CAPKA_BRANCH it picks the
# newest release of that major, and it refuses a target in a newer major unless
# CAPKA_ALLOW_MAJOR=1 (read that release's notes first). A prerelease tag
# (vX.Y.Z-rc.N) is refused unless CAPKA_ALLOW_PRERELEASE=1.
set -eu

# Run from the repo root regardless of where the script is invoked from.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# The major of a vX.Y.Z tag, or nothing for anything else.
major() {
  m="${1#v}"; m="${m%%.*}"
  case "$m" in ''|*[!0-9]*) ;; *) echo "$m" ;; esac
}

# The release installed now. Unknown (no tag on this checkout) disables the
# major-version guard rather than guessing.
CURRENT_MAJOR="$(major "$(git describe --tags --abbrev=0 2>/dev/null || true)")"

# Pick the ref to update to: an explicit CAPKA_BRANCH, else the newest release
# tag of the installed major (any major with CAPKA_ALLOW_MAJOR=1), else fall
# back to master (e.g. before any release is cut). Prerelease tags never count.
if [ -z "${CAPKA_BRANCH:-}" ]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || echo)"
  RELEASES="$(git ls-remote --tags --refs "$REMOTE" 'v*' 2>/dev/null | awk -F/ '{ print $NF }' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V || true)"
  NEWEST="$(printf '%s\n' "$RELEASES" | tail -n1)"
  LATEST="$NEWEST"
  if [ -n "$CURRENT_MAJOR" ] && [ "${CAPKA_ALLOW_MAJOR:-}" != "1" ]; then
    LATEST="$(printf '%s\n' "$RELEASES" | grep -E "^v${CURRENT_MAJOR}\." | tail -n1 || true)"
    if [ -n "$NEWEST" ] && [ "$NEWEST" != "$LATEST" ]; then
      echo "Note: $NEWEST is a new major version. Staying on v$CURRENT_MAJOR.x; to move, read its release notes, then run:" >&2
      echo "  CAPKA_ALLOW_MAJOR=1 ./scripts/update.sh" >&2
    fi
  fi
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

# The release the target ref IS — for `stable`, the tag on the commit it points
# at — checked after the fetch and still before the checkout.
case "$CAPKA_BRANCH" in
  v*)     TARGET="$CAPKA_BRANCH" ;;
  stable) TARGET="$(git describe --tags --exact-match FETCH_HEAD 2>/dev/null || true)" ;;
  *)      TARGET="" ;;
esac
case "$TARGET" in
  v*-*)
    if [ "${CAPKA_ALLOW_PRERELEASE:-}" != "1" ]; then
      echo "Refusing to update to prerelease $TARGET: it is a test build, not a release." >&2
      echo "To run it anyway:  CAPKA_ALLOW_PRERELEASE=1 CAPKA_BRANCH=$TARGET ./scripts/update.sh" >&2
      exit 1
    fi
    ;;
esac
TARGET_MAJOR="$(major "${TARGET%%-*}")"
if [ -n "$CURRENT_MAJOR" ] && [ -n "$TARGET_MAJOR" ] && [ "$TARGET_MAJOR" -gt "$CURRENT_MAJOR" ] \
   && [ "${CAPKA_ALLOW_MAJOR:-}" != "1" ]; then
  echo "Refusing to update from v$CURRENT_MAJOR.x to $TARGET: a new major version can need manual steps." >&2
  echo "Read its release notes, then run:  CAPKA_ALLOW_MAJOR=1 CAPKA_BRANCH=$CAPKA_BRANCH ./scripts/update.sh" >&2
  exit 1
fi

# Reset to the target ref (clean, predictable); .env is gitignored and preserved.
git checkout -f FETCH_HEAD >/dev/null 2>&1 || git checkout -f "$CAPKA_BRANCH"

# Hand the tag to up.sh, which owns .env: it persists the pin (rewriting an older
# one) and uses this value for the compose invocation regardless of what is in the
# file. Writing .env from two scripts is how the two get to disagree.
export CAPKA_VERSION="$TAG"

exec sh scripts/up.sh
