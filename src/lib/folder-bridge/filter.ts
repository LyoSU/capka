/**
 * What a PC folder sync should skip, so it never crawls or uploads the things that
 * make sync unbearably slow (and blow the sandbox quota): dependency/build trees
 * (node_modules, .git, venv…), model/binary blobs (*.gguf, *.safetensors…), and any
 * single file over a size cap. Pure and unit-tested; the bridge applies it on both
 * the local walk (skip descending an ignored dir) and the server tree (so the same
 * junk on the server is never pulled down). Not user-configurable by design — the
 * audience is non-technical, and a fixed sane list covers the real cases.
 */

/** Directory/segment names that are never worth syncing — matched on ANY path
 *  segment, so `a/node_modules/b` is skipped wherever it appears. */
const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".next", ".nuxt", ".cache", "dist", "build",
  "target", ".gradle", ".idea", ".vscode", ".DS_Store", ".Trash",
]);

/** File extensions for model weights / big binaries that should never sync. */
const IGNORE_EXT = [
  ".safetensors", ".gguf", ".ggml", ".bin", ".pt", ".pth", ".onnx", ".ckpt",
  ".h5", ".pb", ".tflite", ".iso", ".dmg", ".vmdk", ".qcow2",
];

/** Per-file size cap (a model/video/archive over this is skipped and reported). */
export const FOLDER_MAX_FILE_MB = 100;
/** Ceiling that blocks attaching a folder outright (checked after filtering). */
export const FOLDER_MAX_FILES = 5000;
export const FOLDER_MAX_TOTAL_MB = 100;

/** Is this path (file OR directory) one we never sync? Used to skip descending an
 *  ignored directory during the walk, and to drop ignored files on both sides. */
export function ignoredPath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  const base = segs[segs.length - 1] ?? "";
  if (base === "Thumbs.db" || base.startsWith("~$") || base.startsWith(".~lock.")) return true;
  if (segs.some((s) => IGNORE_SEGMENTS.has(s))) return true;
  const lower = base.toLowerCase();
  return IGNORE_EXT.some((ext) => lower.endsWith(ext));
}

/** A single file too big to sync (in bytes vs the MB cap). */
export function oversized(size: number): boolean {
  return size > FOLDER_MAX_FILE_MB * 1024 * 1024;
}
