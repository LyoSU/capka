import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart } from "ai";
import { nanoid } from "nanoid";
import { extractWorkspacePaths } from "@/lib/chat/artifacts";
import { audioNeedsTranscode } from "@/lib/providers/registry";
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
// downscale can't consume the sandbox PID/thread budget (see view-file.ts).
const RENDER_THREADS = 2;
// Long-edge target + JPEG quality for the downscaled copy. Providers downsample
// images to ~1568px internally, so 2048 keeps small-text legibility (receipts,
// contracts, whiteboards) with headroom to spare; the copy lands well under the
// per-image caps that oversize originals blow past.
const DOWNSCALE_LONG_EDGE = 2048;
const DOWNSCALE_QUALITY = 83;
// Only re-encode originals large enough to be worth it (and to risk the caps).
const DOWNSCALE_OVER_BYTES = 3 * 1024 * 1024;
// Raster formats ImageMagick can safely re-encode. GIF is excluded (a re-encode
// would flatten animation); SVG/HEIC and anything else fall through untouched to
// the download path, where the honest injected-set return still routes an
// oversize file to the tool path instead of falsely promising it inline.
const DOWNSCALABLE = new Set(["image/jpeg", "image/pjpeg", "image/png", "image/webp"]);

/**
 * Shrink oversized raster images IN THE SANDBOX before injection — mirrors
 * `transcodeUnsupportedAudio`. A full-res phone photo is both wasteful (the
 * provider never sees more than ~1568px) and a false-native hazard: it blows
 * past the native byte cap and gets silently dropped. The downscaled copy goes
 * to a hidden per-turn dir so the user's ORIGINAL stays in /workspace intact
 * (full resolution, EXIF/GPS) for `view_file` and metadata questions. Returns a
 * `files` array index-aligned with the input; on any failure the original ref
 * is kept, so a downscale hiccup never becomes a hard turn failure.
 */
async function downscaleLargeImages(
  sessionKey: string,
  userId: string,
  files: FileRef[],
): Promise<{ files: FileRef[]; cleanupDir?: string }> {
  if (!files.some((f) => DOWNSCALABLE.has(f.type))) return { files };
  const dir = `.capka/native-img/${nanoid(8)}`;
  const out = await Promise.all(
    files.map(async (f, i) => {
      if (!DOWNSCALABLE.has(f.type)) return f;
      // PNG stays PNG (lossless resize keeps alpha + text crisp); everything
      // else normalizes to JPEG.
      const keepPng = f.type === "image/png";
      const dest = `${dir}/${i}.${keepPng ? "png" : "jpg"}`;
      try {
        const r = await execCommand(
          sessionKey,
          `src=/workspace/${shq(f.name)}; ` +
            `sz=$(stat -c%s "$src" 2>/dev/null || echo 0); ` +
            `if [ "$sz" -le ${DOWNSCALE_OVER_BYTES} ]; then echo __KEEP__; exit 0; fi; ` +
            `mkdir -p /workspace/${shq(dir)} && ` +
            `convert -limit thread ${RENDER_THREADS} "$src[0]" -auto-orient ` +
            `-resize '${DOWNSCALE_LONG_EDGE}x${DOWNSCALE_LONG_EDGE}>'` +
            `${keepPng ? "" : ` -quality ${DOWNSCALE_QUALITY}`} /workspace/${shq(dest)} && echo __DONE__`,
          120_000,
        );
        if (r.exitCode === 0 && r.stdout.includes("__DONE__")) {
          return { name: dest, type: keepPng ? "image/png" : "image/jpeg" };
        }
        // __KEEP__ (already small) or a convert failure — use the original.
        return f;
      } catch (e) {
        log.warn("image downscale errored; keeping original", { userId, file: f.name, err: String(e) });
        return f;
      }
    }),
  );
  return { files: out, cleanupDir: dir };
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
  const img = await downscaleLargeImages(sessionKey, userId, audio.files);
  const prepared = img.files;
  const cleanupDirs = [audio.cleanupDir, img.cleanupDir].filter((d): d is string => !!d);

  const downloaded = await downloadBounded(prepared, sessionKey, userId);
  // Ephemeral transcode/downscale output — remove once its bytes are in the
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
  lastUser.content = [...existing, ...parts];

  log.info("injected native files", { userId, count: parts.length, bytes: totalBytes });
  return downloaded.map(({ index }) => files[index]);
}
