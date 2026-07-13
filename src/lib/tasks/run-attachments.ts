import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { nanoid } from "nanoid";
import { extractWorkspacePaths } from "@/lib/chat/artifacts";
import { audioNeedsTranscode, NATIVE_IMAGE_FORMATS } from "@/lib/providers/registry";
import { downloadFile, execCommand } from "@/lib/sandbox/client";
import { MAX_NATIVE_FILE_BYTES, MAX_NATIVE_TOTAL_BYTES, type FileRef } from "@/lib/constants";
import { log } from "@/lib/log";

// The native-attachment plumbing for a turn: pulling the user's multimodal files
// out of the sandbox (bounded), transcoding audio the transport can't serialize,
// injecting them into the prompt, and gathering the reply's referenced files for
// channels that can't browse the workspace (Telegram). Split out of runner.ts so
// the turn loop reads as control flow, not file wrangling.

/** Max concurrent file downloads from sandbox */
const MAX_CONCURRENT_DOWNLOADS = 5;

const MAX_OUTPUT_FILES = 10;
const MAX_OUTPUT_FILE_BYTES = 45 * 1024 * 1024; // under Telegram's 50 MB document cap
const MAX_OUTPUT_TOTAL_BYTES = 50 * 1024 * 1024;

/** Download files with bounded concurrency and total size budget. Each result
 *  carries its `index` in `files` so the caller can map a prepared/downscaled
 *  copy back to the original attachment it stands in for. */
async function downloadBounded(
  files: FileRef[],
  sessionKey: string,
  userId: string,
): Promise<{ index: number; file: FileRef; buf: Buffer }[]> {
  const results: { index: number; file: FileRef; buf: Buffer }[] = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (totalBytes >= MAX_NATIVE_TOTAL_BYTES) break;

    const batch = files.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const settled = await Promise.allSettled(
      batch.map(async (file, j) => {
        const res = await downloadFile(sessionKey, file.name, userId);
        return { index: i + j, file, buf: Buffer.from(await res.arrayBuffer()) };
      }),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        log.warn("native file read failed", { userId, err: String(r.reason) });
        continue;
      }
      const { file, buf } = r.value;
      if (buf.length > MAX_NATIVE_FILE_BYTES) {
        log.info("skipping native file: over per-file limit", { userId, file: file.name, bytes: buf.length });
        continue;
      }
      if (totalBytes + buf.length > MAX_NATIVE_TOTAL_BYTES) {
        log.info("skipping native file: over aggregate limit", { userId, file: file.name, bytes: buf.length });
        continue;
      }
      totalBytes += buf.length;
      results.push(r.value);
    }
  }
  return results;
}

/**
 * The workspace files the agent's reply explicitly refers to by their
 * `/workspace/…` path — the same "artifacts" the web transcript surfaces as file
 * tiles. Delivered to channels that can't browse the sandbox (Telegram); we send
 * what the model points at, not every file it happened to touch. Bounded in
 * count and bytes, always best-effort.
 */
export async function collectReferencedFiles(sessionKey: string, userId: string, text: string) {
  const paths = extractWorkspacePaths(text).slice(0, MAX_OUTPUT_FILES);
  const out: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (const rel of paths) {
    try {
      const res = await downloadFile(sessionKey, rel, userId);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_OUTPUT_FILE_BYTES || total + buf.length > MAX_OUTPUT_TOTAL_BYTES) continue;
      total += buf.length;
      out.push({ name: rel.split("/").pop() || rel, data: buf });
    } catch (e) {
      // A referenced path might be a directory or only mentioned, not a real
      // downloadable file — skip it quietly.
      log.warn("referenced file download failed", { userId, file: rel, err: String(e) });
    }
  }
  return out;
}

// Single-quote a path for `sh -c` so a user-supplied filename can't break out
// of the ffmpeg argument. `'…'` is literal in sh; the only escape needed is the
// quote itself.
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Transcode any attached audio whose container the target transport can't
 * serialize (only wav/mp3 are universal — see `audioNeedsTranscode`) into mp3,
 * using the sandbox's ffmpeg. Returns FileRefs pointing at the converted copies
 * (in a per-turn hidden dir) so the normal download path picks them up. Purely
 * best-effort: on any failure the original FileRef is kept and the runner's
 * soft-retry strips it with a note if the provider then rejects it — a transcode
 * hiccup never becomes a hard turn failure. The hidden dir is removed after.
 */
async function transcodeUnsupportedAudio(
  sessionKey: string,
  userId: string,
  provider: string,
  files: FileRef[],
): Promise<{ files: FileRef[]; cleanupDir?: string }> {
  if (!files.some((f) => audioNeedsTranscode(f.type, provider))) return { files };
  const dir = `.capka/native-audio/${nanoid(8)}`;
  const out = await Promise.all(
    files.map(async (f, i) => {
      if (!audioNeedsTranscode(f.type, provider)) return f;
      const dest = `${dir}/${i}.mp3`;
      try {
        const r = await execCommand(
          sessionKey,
          `mkdir -p /workspace/${shq(dir)} && ffmpeg -y -nostdin -i /workspace/${shq(f.name)} -vn -ac 1 -c:a libmp3lame -q:a 4 /workspace/${shq(dest)}`,
          120_000,
        );
        if (r.exitCode !== 0) {
          log.warn("audio transcode failed; keeping original", {
            userId, file: f.name, exitCode: r.exitCode, stderr: r.stderr.slice(-300),
          });
          return f;
        }
        return { name: dest, type: "audio/mpeg" };
      } catch (e) {
        log.warn("audio transcode errored; keeping original", { userId, file: f.name, err: String(e) });
        return f;
      }
    }),
  );
  return { files: out, cleanupDir: dir };
}

// ImageMagick defaults its worker pool from the host CPU count; cap it so a
// re-encode can't consume the sandbox PID/thread budget (see view-file.ts).
const RENDER_THREADS = 2;
// Long-edge downscale target. Providers cap what they actually process (Claude
// standard 1568px, high-resolution tier 2576px; others tile comparably), so a
// copy at this size keeps small-text legibility (receipts, contracts, UI
// screenshots) while staying comfortably under every per-image byte limit. The
// user's ORIGINAL is never touched — it stays in /workspace at full resolution
// with EXIF/GPS intact for `view_file` and metadata questions.
const IMAGE_LONG_EDGE = 2048;
// JPEG quality for a re-encoded copy — high enough that thin fonts and table
// rules survive (provider docs warn aggressive JPEG compression eats small text),
// low enough to stay small.
const IMAGE_JPEG_QUALITY = 90;
// Re-encode an image whose raw bytes exceed this even when its dimensions are
// already fine: a small-dimension but multi-MB file (noisy PNG, un-optimized
// export) can otherwise blow past a provider's per-image byte ceiling
// (Anthropic ~5MB base64). Converting to JPEG at that point reliably shrinks it.
const IMAGE_REENCODE_OVER_BYTES = 3.5 * 1024 * 1024;
// Raster formats ImageMagick can decode and re-encode. GIF is included so a huge
// animated GIF normalizes to its static first frame (all a vision model sees of
// it anyway). SVG and vector/unknown formats are absent on purpose — they never
// reach here because `acceptsNativeFile` already routes non-deliverable formats
// to the tool path.
const NORMALIZABLE = new Set([
  "image/jpeg", "image/pjpeg", "image/png", "image/gif", "image/webp",
  "image/heic", "image/heif", "image/tiff", "image/bmp", "image/avif",
]);

/**
 * The atomic sandbox step for one image: read its real geometry with `identify`,
 * decide whether a re-encode is needed, pick the output format, and convert.
 * Echoes `__KEEP__` (leave the original as-is), `__DONE__ png|jpg` (re-encoded
 * copy written), or `__ERR__`.
 *
 * A re-encode is triggered when the format isn't natively transportable (caller
 * sets `force`), the image is larger than the long-edge target, it carries EXIF
 * orientation the provider would ignore (no provider auto-rotates — the top
 * cause of "the model sees my photo sideways"), it's in a CMYK color space, or
 * its bytes exceed the ceiling. `-auto-orient` bakes rotation into pixels,
 * `-strip` drops the now-redundant metadata, `-colorspace sRGB` fixes CMYK, and
 * JPEG output flattens alpha onto white so transparency can't render as black.
 */
function normalizeImageScript(
  name: string,
  dir: string,
  base: string,
  opts: { edge: number; quality: number; overBytes: number; force: boolean; srcIsPng: boolean },
): string {
  const { edge, quality, overBytes, force, srcIsPng } = opts;
  const src = `/workspace/${shq(name)}`;
  // `set -- $info` word-splits identify's space-separated fields; the values
  // (dimensions, an orientation keyword, a colorspace keyword) never contain
  // spaces. `"$src[0]"` selects the first frame of a multi-frame image.
  return `set -e
src=${src}
bytes=$(stat -c%s "$src" 2>/dev/null || echo 0)
info=$(identify -format '%w %h %[orientation] %[colorspace]' "$src[0]" 2>/dev/null | head -1)
[ -z "$info" ] && { echo __ERR__; exit 0; }
set -- $info; w=$1; h=$2; orient=$3; cs=$4
need=${force ? "1" : "0"}; over=0
{ [ "\${w:-0}" -gt ${edge} ] || [ "\${h:-0}" -gt ${edge} ]; } && need=1
case "$orient" in ""|Undefined|TopLeft) ;; *) need=1 ;; esac
[ "$cs" = "CMYK" ] && need=1
[ "\${bytes:-0}" -gt ${overBytes} ] && { need=1; over=1; }
[ "$need" != 1 ] && { echo __KEEP__; exit 0; }
mkdir -p /workspace/${shq(dir)}
if [ ${srcIsPng ? "1" : "0"} = 1 ] && [ "$over" != 1 ]; then
  convert -limit thread ${RENDER_THREADS} "$src[0]" -auto-orient -resize '${edge}x${edge}>' -colorspace sRGB -strip /workspace/${shq(`${base}.png`)} && echo "__DONE__ png" || echo __ERR__
else
  convert -limit thread ${RENDER_THREADS} "$src[0]" -auto-orient -resize '${edge}x${edge}>' -colorspace sRGB -background white -flatten -quality ${quality} -strip /workspace/${shq(`${base}.jpg`)} && echo "__DONE__ jpg" || echo __ERR__
fi`;
}

/**
 * Normalize attached raster images IN THE SANDBOX before injection so the bytes
 * that reach the vision model are a format the provider accepts and can read
 * well — mirrors `transcodeUnsupportedAudio`. Each image is re-encoded only when
 * needed (see `normalizeImageScript`); a correctly-oriented, accepted-format,
 * in-budget image is passed through untouched.
 *
 * Returns a `refs` array index-aligned with the input:
 *  - a re-encoded copy (hidden per-turn dir) for images that were normalized,
 *  - the original ref for images left as-is (or whose re-encode failed but whose
 *    format is natively deliverable anyway),
 *  - `null` for a NON-native format whose re-encode failed — it can't be sent
 *    inline, so it's dropped here and the caller routes it to the tool path
 *    rather than injecting bytes the provider would 400 on.
 */
async function normalizeImagesForProvider(
  sessionKey: string,
  userId: string,
  files: FileRef[],
): Promise<{ refs: (FileRef | null)[]; cleanupDir?: string }> {
  if (!files.some((f) => NORMALIZABLE.has(f.type))) return { refs: files };
  const dir = `.capka/native-img/${nanoid(8)}`;
  const refs = await Promise.all(
    files.map(async (f, i): Promise<FileRef | null> => {
      if (!NORMALIZABLE.has(f.type)) return f;
      const nativeRaw = NATIVE_IMAGE_FORMATS.has(f.type);
      const base = `${dir}/${i}`;
      try {
        const r = await execCommand(
          sessionKey,
          normalizeImageScript(f.name, dir, base, {
            edge: IMAGE_LONG_EDGE,
            quality: IMAGE_JPEG_QUALITY,
            overBytes: IMAGE_REENCODE_OVER_BYTES,
            force: !nativeRaw,
            srcIsPng: f.type === "image/png",
          }),
          120_000,
        );
        const done = r.stdout.match(/__DONE__ (png|jpg)/);
        if (r.exitCode === 0 && done) {
          const ext = done[1];
          return { name: `${base}.${ext}`, type: ext === "png" ? "image/png" : "image/jpeg" };
        }
        if (r.stdout.includes("__KEEP__")) return f;
        // __ERR__ or unexpected output. A natively-deliverable format is still
        // fine to send as-is; a convertible-only one is not — drop it so the
        // caller uses the tool path instead of injecting a format the provider
        // rejects.
        if (!nativeRaw) {
          log.info("image normalize failed for non-native format; routing to tools", { userId, file: f.name, type: f.type });
          return null;
        }
        return f;
      } catch (e) {
        log.warn("image normalize errored", { userId, file: f.name, err: String(e) });
        return nativeRaw ? f : null;
      }
    }),
  );
  return { refs, cleanupDir: dir };
}

/**
 * Read multimodal files from sandbox and inject as FilePart in the last user
 * message. Returns the ORIGINAL FileRefs whose bytes actually reached the model
 * — the caller announces only those as inline-readable and routes the rest to
 * the tool path, so a file that couldn't be delivered (download failed, still
 * over cap after downscale, aggregate budget) is never falsely promised visible.
 */
export async function injectNativeFiles(
  modelMessages: ModelMessage[],
  sessionKey: string,
  userId: string,
  provider: string,
  files: FileRef[],
): Promise<FileRef[]> {
  if (files.length === 0) return [];

  const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
  if (!lastUser) return [];

  // Prepare in-sandbox copies the transport can actually carry, each step
  // index-aligned with `files` so a substitute maps back to its original.
  const audio = await transcodeUnsupportedAudio(sessionKey, userId, provider, files);
  const img = await normalizeImagesForProvider(sessionKey, userId, audio.files);
  const cleanupDirs = [audio.cleanupDir, img.cleanupDir].filter((d): d is string => !!d);

  // `img.refs` is index-aligned with `files`; a `null` entry is an image whose
  // format couldn't be made deliverable — it's excluded from the download and
  // the injected set so the caller routes it to the tool path. Carry each
  // survivor's ORIGINAL index so the returned set names the user's file, not the
  // hidden re-encoded copy.
  const pending = img.refs
    .map((ref, index) => ({ ref, index }))
    .filter((e): e is { ref: FileRef; index: number } => e.ref !== null);

  const downloaded = await downloadBounded(pending.map((e) => e.ref), sessionKey, userId);
  // Ephemeral transcode/normalize output — remove once its bytes are in the
  // prompt. Fire and forget; the workspace is disposable and GC'd with the
  // sandbox anyway.
  for (const d of cleanupDirs) {
    execCommand(sessionKey, `rm -rf /workspace/${shq(d)}`).catch(() => {});
  }
  if (downloaded.length === 0) return [];

  const parts: FilePart[] = downloaded.map(({ file, buf }) => ({
    type: "file", mediaType: file.type, data: buf, filename: file.name,
  }));
  const totalBytes = downloaded.reduce((sum, { buf }) => sum + buf.length, 0);

  type UserPart = TextPart | ImagePart | FilePart;
  const existing: UserPart[] = typeof lastUser.content === "string"
    ? [{ type: "text", text: lastUser.content }]
    : [...lastUser.content];
  // Attachments go BEFORE the user's text: providers (Anthropic says so
  // explicitly) attend to images best when they precede the prompt text.
  lastUser.content = [...parts, ...existing];

  log.info("injected native files", { userId, count: parts.length, bytes: totalBytes });
  // `downloadBounded` indexes into the array it was handed (`pending`), so map
  // each result back through `pending` to the caller's original FileRef.
  return downloaded.map(({ index }) => files[pending[index].index]);
}
