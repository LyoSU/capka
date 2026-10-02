import { requireSession, apiHandler } from "@/lib/auth";
import { execCommand, listFiles } from "@/lib/sandbox/client";
import { resolveWorkspaceTarget, targetParamsFrom } from "@/lib/sandbox/target";
import { PDF_CHUNK_BYTES, PDF_CHUNK_SCRIPT, THUMBNAIL_SCRIPT, thumbnailKey, workspaceRelative } from "@/lib/sandbox/thumbnail";
import { previewKind } from "@/lib/file-kinds";
import { log } from "@/lib/log";

// Past this a converted document is a download, not a preview: every 700 KB is one
// more exec round trip (the controller caps an exec's output at 1 MB).
const MAX_PDF_BYTES = 20 * 1024 * 1024;

type Outcome = { ok: true; pdf: Buffer } | { ok: false; status: number; reason: string };

// One conversion per file version at a time: a second viewer opening the same
// document (two tabs, a remount) waits for the first one's result. Entries leave
// as soon as they settle, so this holds only what is in flight.
const inflight = new Map<string, Promise<Outcome>>();

// File versions LibreOffice could not convert, so reopening one does not re-run it
// for a minute of nothing. Bounded like the thumbnail route's: oldest out past 500.
const failed = new Map<string, { until: number; reason: string }>();
const FAILED_TTL_MS = 10 * 60_000;

// The script's exit codes, worded for an admin. A regular user never sees these.
const REASONS: Record<number, string> = {
  4: "the file is not in the workspace",
  5: "the file is over the 30 MB conversion limit",
  6: "the sandbox's /tmp is full",
  7: "another conversion is still running in this sandbox",
  8: "LibreOffice could not convert the file (or took over 40 s)",
};

async function convert(sessionKey: string, rel: string, key: string): Promise<Outcome> {
  const made = await execCommand(sessionKey, THUMBNAIL_SCRIPT, 60_000, undefined, {
    CAPKA_THUMB_PATH: rel,
    CAPKA_THUMB_KEY: key,
    CAPKA_THUMB_FORMAT: "pdf",
  }).catch(() => null); // no running sandbox, or the controller said no
  if (!made) return { ok: false, status: 503, reason: "the chat's sandbox is not running" };
  if (made.exitCode === 7) return { ok: false, status: 503, reason: REASONS[7] };
  const size = Number(made.stdout.trim());
  if (made.exitCode !== 0 || !Number.isInteger(size) || size <= 0) {
    log.info("document preview conversion failed", { exitCode: made.exitCode });
    return { ok: false, status: 422, reason: REASONS[made.exitCode] ?? `conversion exited with code ${made.exitCode}` };
  }
  if (size > MAX_PDF_BYTES) return { ok: false, status: 413, reason: `the converted PDF is ${Math.round(size / 1048576)} MB, over the 20 MB preview limit` };

  const parts: Buffer[] = [];
  for (let i = 0; i * PDF_CHUNK_BYTES < size; i++) {
    const chunk = await execCommand(sessionKey, PDF_CHUNK_SCRIPT, 30_000, undefined, {
      CAPKA_THUMB_KEY: key,
      CAPKA_PDF_CHUNK: String(i),
    }).catch(() => null);
    // A chunk that went missing (evicted by another conversion) or came back cut
    // short fails the whole read; the viewer offers to try again.
    if (!chunk || chunk.exitCode !== 0 || chunk.truncated) return { ok: false, status: 503, reason: "reading the converted PDF out of the sandbox failed" };
    parts.push(Buffer.from(chunk.stdout, "base64"));
  }
  const pdf = Buffer.concat(parts);
  if (pdf.length !== size) return { ok: false, status: 503, reason: "the converted PDF changed while it was being read" };
  return { ok: true, pdf };
}

/** A Word, PowerPoint, OpenDocument or RTF file as a PDF, for the in-app viewer.
 *  Converted in the workspace's own sandbox by the thumbnail pipeline, which keeps
 *  the PDF in its cache — so a document whose tile already rendered previews
 *  without running LibreOffice again. Like the thumbnail, it never starts a
 *  sandbox: with none running it answers 503 and the viewer says so.
 *
 *  Failures are JSON. `reason` is for an admin and only ever sent to one. */
export const GET = apiHandler(async (req: Request) => {
  const { userId, role } = await requireSession();
  const fail = (status: number, reason: string) =>
    Response.json(role === "admin" ? { error: "No preview", reason } : { error: "No preview" }, { status });
  const { searchParams } = new URL(req.url);
  const rel = workspaceRelative(searchParams.get("path") ?? "");
  if (!rel || previewKind(rel) !== "office") return fail(404, "not a document this route converts");

  const { sessionKey } = await resolveWorkspaceTarget({ userId, ...targetParamsFrom(searchParams) });
  const slash = rel.lastIndexOf("/");
  const listing = await listFiles(sessionKey, slash > 0 ? rel.slice(0, slash) : ".", userId).catch(() => null);
  if (!listing) return fail(503, "the workspace could not be listed");
  const entry = listing.entries.find((e) => !e.isDirectory && e.path.replace(/^\.\//, "") === rel);
  if (!entry) return fail(404, REASONS[4]);

  const key = thumbnailKey(sessionKey, rel, entry.modifiedAt, entry.size);
  const etag = `"${key}"`;
  const headers = {
    "Content-Type": "application/pdf",
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  const known = failed.get(key);
  if (known && known.until > Date.now()) return fail(422, known.reason);

  let job = inflight.get(key);
  if (!job) {
    job = convert(sessionKey, rel, key);
    inflight.set(key, job);
    void job.finally(() => inflight.delete(key));
  }
  const result = await job;
  if (!result.ok) {
    if (result.status === 422 || result.status === 413) {
      failed.set(key, { until: Date.now() + FAILED_TTL_MS, reason: result.reason });
      if (failed.size > 500) failed.delete(failed.keys().next().value!);
    }
    return fail(result.status, result.reason);
  }
  return new Response(new Uint8Array(result.pdf), { headers });
});
