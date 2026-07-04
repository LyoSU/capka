/**
 * What a PC folder sync should skip, so it never crawls or uploads the things that
 * make sync unbearably slow (and blow the sandbox quota): dependency/build trees
 * (node_modules, .git, venv…), model/binary blobs (*.gguf, *.safetensors…), and any
 * single file over a size cap. Pure and unit-tested; the bridge applies it on both
 * the local walk (skip descending an ignored dir) and the server tree (so the same
 * junk on the server is never pulled down). Not user-configurable by design — the
 * audience is non-technical, and a fixed sane list covers the real cases.
 */

/** Directory/segment names that are never worth syncing — matched (case-sensitively)
 *  on ANY path segment, so `a/node_modules/b` is skipped wherever it appears. Case
 *  sensitivity is deliberate: build tools emit lowercase `dist`/`build`/`target`, so
 *  a user's own "Build" or "Target" folder is untouched. Only distinctive names are
 *  listed — bare generic words (env, bin, obj, vendor, coverage) are omitted so they
 *  never eat a legitimate folder. */
const IGNORE_SEGMENTS = new Set([
  // Package/dependency trees
  "node_modules", "bower_components", "jspm_packages",
  // Version control
  ".git", ".hg", ".svn", ".bzr", "_darcs",
  // Python envs & caches
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", ".eggs",
  ".ipynb_checkpoints", ".dart_tool", ".pub-cache",
  // JS/build framework caches & outputs
  ".next", ".nuxt", ".svelte-kit", ".angular", ".expo", ".output", ".vercel",
  ".netlify", ".turbo", ".parcel-cache", ".nyc_output", ".cache", "dist", "build",
  "target", ".gradle", ".settings", ".idea", ".vscode",
  // Infra
  ".terraform", ".serverless",
  // macOS
  ".DS_Store", ".AppleDouble", ".Spotlight-V100", ".Trashes", ".fseventsd",
  ".TemporaryItems", ".Trash", "__MACOSX",
  // Windows
  "$RECYCLE.BIN", "System Volume Information",
]);

/** File extensions for model weights / disk images that should never sync. Only
 *  UNAMBIGUOUS blob formats — ambiguous containers are left to the size cap so a
 *  user's real file is never silently dropped: .h5/HDF5, .npy, .parquet (data),
 *  and deliberately NOT .bin/.pb (firmware, protobuf schemas, small fixtures,
 *  embedded assets — a big model .bin is caught by the size cap anyway). */
const IGNORE_EXT = [
  // Model weights
  ".safetensors", ".gguf", ".ggml", ".pt", ".pth", ".onnx", ".ckpt",
  ".tflite", ".mlmodel", ".caffemodel",
  // Disk / VM images
  ".iso", ".dmg", ".img", ".vmdk", ".qcow2", ".vdi", ".vhd", ".vhdx", ".ova",
];

/** Per-file size cap (a model/video/archive over this is skipped and reported). */
export const FOLDER_MAX_FILE_MB = 100;
/** Ceiling that blocks attaching a folder outright (checked after filtering). */
export const FOLDER_MAX_FILES = 5000;
export const FOLDER_MAX_TOTAL_MB = 100;

/** Thrown when a folder exceeds the attach ceiling (too many files or bytes AFTER
 *  filtering). Carries the numbers so the UI can localize the message; identified by
 *  `name` (string) so it survives the dynamic-import boundary and both the live-sync
 *  and one-shot-import paths raise the exact same shape. */
export class FolderTooLargeError extends Error {
  constructor(public count: number, public bytes: number) {
    super("folder too large");
    this.name = "FolderTooLargeError";
  }
}

/** Does this (already-filtered) count/byte total exceed the attach ceiling? Shared
 *  by the live-sync picker and the one-shot fallback so both refuse the same folders. */
export function exceedsCeiling(count: number, bytes: number): boolean {
  return count > FOLDER_MAX_FILES || bytes > FOLDER_MAX_TOTAL_MB * 1024 * 1024;
}

/** Is this path (file OR directory) one we never sync? Used to skip descending an
 *  ignored directory during the walk, and to drop ignored files on both sides. */
export function ignoredPath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  const base = segs[segs.length - 1] ?? "";
  const lower = base.toLowerCase();

  // OS / editor junk files by name or pattern.
  if (
    base.startsWith("._") ||        // macOS AppleDouble resource forks
    base.startsWith("~$") ||         // Office owner/lock files
    base.startsWith(".~lock.") ||    // LibreOffice locks
    base.endsWith("~") ||            // editor backups (foo.txt~)
    lower === "thumbs.db" || lower === "ehthumbs.db" ||
    lower === "desktop.ini" || lower === ".localized" ||
    lower.endsWith(".swp") || lower.endsWith(".swo") ||  // vim swap
    lower.endsWith(".tmp") || lower.endsWith(".temp")
  ) return true;

  if (segs.some((s) => IGNORE_SEGMENTS.has(s))) return true;
  return IGNORE_EXT.some((ext) => lower.endsWith(ext));
}

/** A single file too big to sync (in bytes vs the MB cap). */
export function oversized(size: number): boolean {
  return size > FOLDER_MAX_FILE_MB * 1024 * 1024;
}
