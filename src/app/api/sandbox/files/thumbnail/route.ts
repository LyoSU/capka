import { requireSession, apiHandler } from "@/lib/auth";
import { execCommand, listFiles } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";
import { THUMBNAIL_SCRIPT, thumbnailKey, workspaceRelative } from "@/lib/sandbox/thumbnail";
import { thumbnailable } from "@/lib/file-kinds";
import { log } from "@/lib/log";

const none = () => new Response(null, { status: 404 });

// File versions whose render failed (a corrupt document, a timeout), so a grid
// re-mounting does not re-run LibreOffice on them every time. Bounded: past 500
// entries the oldest goes first (Map keeps insertion order).
const failed = new Map<string, number>();
const FAILED_TTL_MS = 10 * 60_000;

/** First page of an office document or PDF as a PNG, for file tiles. Rendered in
 *  the workspace's own sandbox — but only if one is already running: the exec goes
 *  straight to the controller, which answers 404/409 for a workspace with no live
 *  container instead of starting one, and any failure is a plain 404 the tile
 *  turns back into its icon. */
export const GET = apiHandler(async (req: Request) => {
  const { userId } = await requireSession();
  const { searchParams } = new URL(req.url);
  const rel = workspaceRelative(searchParams.get("path") ?? "");
  if (!rel || !thumbnailable(rel)) return none();

  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const slash = rel.lastIndexOf("/");
  const listing = await listFiles(sessionKey, slash > 0 ? rel.slice(0, slash) : ".", userId).catch(() => null);
  const entry = listing?.entries.find((e) => !e.isDirectory && e.path.replace(/^\.\//, "") === rel);
  if (!entry) return none();

  const key = thumbnailKey(sessionKey, rel, entry.modifiedAt, entry.size);
  const etag = `"${key}"`;
  const headers = { "Content-Type": "image/png", "Cache-Control": "private, no-cache", ETag: etag };
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  if ((failed.get(key) ?? 0) > Date.now()) return none();

  const result = await execCommand(sessionKey, THUMBNAIL_SCRIPT, 60_000, undefined, {
    CAPKA_THUMB_PATH: rel,
    CAPKA_THUMB_KEY: key,
  }).catch(() => null); // no running sandbox, or the controller said no
  if (!result) return none();
  if (result.exitCode !== 0 || !result.stdout) {
    log.info("thumbnail render failed", { exitCode: result.exitCode });
    failed.set(key, Date.now() + FAILED_TTL_MS);
    if (failed.size > 500) failed.delete(failed.keys().next().value!);
    return none();
  }
  return new Response(Buffer.from(result.stdout, "base64"), { headers });
});
