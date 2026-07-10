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

/** Download files with bounded concurrency and total size budget */
async function downloadBounded(
  files: FileRef[],
  sessionKey: string,
  userId: string,
): Promise<{ file: FileRef; buf: Buffer }[]> {
  const results: { file: FileRef; buf: Buffer }[] = [];
  let totalBytes = 0;

  for (let i = 0; i < files.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (totalBytes >= MAX_NATIVE_TOTAL_BYTES) break;

    const batch = files.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const settled = await Promise.allSettled(
      batch.map(async (file) => {
        const res = await downloadFile(sessionKey, file.name, userId);
        return { file, buf: Buffer.from(await res.arrayBuffer()) };
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

/** Read multimodal files from sandbox and inject as FilePart in the last user message */
export async function injectNativeFiles(
  modelMessages: ModelMessage[],
  sessionKey: string,
  userId: string,
  provider: string,
  files: FileRef[],
): Promise<void> {
  if (files.length === 0) return;

  const lastUser = modelMessages.findLast((m): m is UserModelMessage => m.role === "user");
  if (!lastUser) return;

  const { files: prepared, cleanupDir } = await transcodeUnsupportedAudio(sessionKey, userId, provider, files);
  const downloaded = await downloadBounded(prepared, sessionKey, userId);
  // Ephemeral transcode output — remove it once its bytes are in the prompt. Fire
  // and forget; the workspace is disposable and GC'd with the sandbox anyway.
  if (cleanupDir) {
    execCommand(sessionKey, `rm -rf /workspace/${shq(cleanupDir)}`).catch(() => {});
  }
  if (downloaded.length === 0) return;

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
}
