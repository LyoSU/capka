/** Tiny semver comparison — just enough to tell "is there a newer release?".
 *  We avoid a dependency: release tags are plain vX.Y.Z, and a pre-release
 *  suffix doesn't change the update decision for our purposes. */

/** Parse a release tag into [major, minor, patch]. Returns null for anything
 *  that isn't a release version (e.g. a local "dev" build or "latest"), so those
 *  are treated as uncomparable rather than misordered. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** >0 if a is newer than b, <0 if older, 0 if equal or either is unparseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** True only when `latest` is a strictly newer release than `current`. A
 *  non-release `current` (a local dev build) never reports an update. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}
