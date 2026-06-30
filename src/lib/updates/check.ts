import { getSetting } from "@/lib/settings";
import { isUpdateAvailable } from "./version";

/** Admin-facing "is a newer Capka out?" check. The running version is stamped
 *  into the image at build time (CAPKA_VERSION); the latest is the newest GitHub
 *  release. The fetch is cached and best-effort — never blocks or throws — and is
 *  skipped entirely when the admin opts out of the check (no outbound call). */

const REPO = "LyoSU/capka";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — releases are infrequent; be a good API citizen
const NOTES_MAX = 4000;

export interface UpdateStatus {
  enabled: boolean; // is the auto-check turned on?
  current: string; // running version, e.g. "v0.2.0" or "dev"
  sha: string | null;
  latest: string | null; // newest release tag
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  notes: string | null; // changelog body (truncated)
  publishedAt: string | null;
  checkedAt: string | null; // when the cached release was last fetched
  error: string | null; // "check_failed" when GitHub was unreachable and nothing cached
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  name: string | null;
  body: string | null;
  published_at: string;
}

let cache: { at: number; release: GithubRelease } | null = null;

async function fetchLatestRelease(): Promise<GithubRelease | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.release;
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "capka-update-check" },
      signal: AbortSignal.timeout(5000),
    });
    // 404 = repo has no releases yet; treat as "nothing to compare", not an error.
    if (res.status === 404) {
      cache = { at: Date.now(), release: { tag_name: "", html_url: "", name: null, body: null, published_at: "" } };
      return cache.release;
    }
    if (!res.ok) return cache?.release ?? null;
    const release = (await res.json()) as GithubRelease;
    cache = { at: Date.now(), release };
    return release;
  } catch {
    // Offline / timeout: fall back to a stale cached value if we have one.
    return cache?.release ?? null;
  }
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const current = process.env.CAPKA_VERSION || "dev";
  const sha = process.env.CAPKA_GIT_SHA || null;
  const enabled = (await getSetting("update_check_enabled")) !== "false"; // default on

  const base: UpdateStatus = {
    enabled, current, sha,
    latest: null, updateAvailable: false, releaseUrl: null,
    releaseName: null, notes: null, publishedAt: null, checkedAt: null, error: null,
  };

  if (!enabled) return base;

  const release = await fetchLatestRelease();
  if (!release) return { ...base, error: "check_failed" };

  const checkedAt = cache ? new Date(cache.at).toISOString() : null;
  if (!release.tag_name) return { ...base, checkedAt }; // no releases published yet

  return {
    ...base,
    latest: release.tag_name,
    updateAvailable: isUpdateAvailable(current, release.tag_name),
    releaseUrl: release.html_url || null,
    releaseName: release.name,
    notes: release.body ? release.body.slice(0, NOTES_MAX) : null,
    publishedAt: release.published_at || null,
    checkedAt,
  };
}

/** Test seam: drop the in-memory release cache. */
export function __resetUpdateCache() {
  cache = null;
}
