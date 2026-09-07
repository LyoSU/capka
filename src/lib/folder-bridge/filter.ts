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

/** Cyrillic to Latin, applied before the charset strip so a folder named in
 *  Ukrainian keeps a readable, DISTINCT name instead of collapsing to "" (and
 *  merging with every other Cyrillic folder into one sandbox directory).
 *
 *  Ukrainian readings win where the two alphabets disagree (he / y / i, not
 *  ge / i / nothing), and the letters Russian does not share with Ukrainian are
 *  mapped too so a mixed folder set still round-trips. Position-dependent
 *  official rules ("ye" at the start of a word, "ie" elsewhere) are deliberately
 *  NOT implemented: this function has to be deterministic and byte-identical on
 *  the server and in the browser, and one reading per letter is the cheapest way
 *  to guarantee that.
 *
 *  The keys are \u escapes rather than the letters themselves because the release
 *  gate (`scripts/release-gate.sh`, check 5) forbids Cyrillic anywhere under
 *  `src/` outside the message catalogues, and this table is code, not copy. Only
 *  lower-case keys are needed: the name is lower-cased first. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  // U+0430..U+043F - a, be, ve, he, de, e, zhe, ze, y, i-short, ka, el, em, en, o, pe.
  "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "h", "\u0434": "d",
  "\u0435": "e", "\u0436": "zh", "\u0437": "z", "\u0438": "y", "\u0439": "i",
  "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n", "\u043e": "o",
  "\u043f": "p",
  // U+0440..U+044F - er, es, te, u, ef, kha, tse, che, sha, shcha, hard sign, yeru,
  // soft sign, e, yu, ya. Both signs drop out: they have no Latin reading.
  "\u0440": "r", "\u0441": "s", "\u0442": "t", "\u0443": "u", "\u0444": "f",
  "\u0445": "kh", "\u0446": "ts", "\u0447": "ch", "\u0448": "sh", "\u0449": "shch",
  "\u044a": "", "\u044b": "y", "\u044c": "", "\u044d": "e", "\u044e": "iu",
  "\u044f": "ia",
  // Outside the base block - yo, Ukrainian ye, Ukrainian dotted i, yi, ge-upturn.
  "\u0451": "e", "\u0454": "ie", "\u0456": "i", "\u0457": "i", "\u0491": "g",
};

/** Canonical mount/workspace name for a folder: the safe id charset the sandbox
 *  path and Docker mount name allow, lower-cased and length-capped. The SINGLE
 *  source of truth — the API routes, the manage control, and the browser bridge
 *  all call this so the name the client derives to adopt an existing row stays
 *  byte-identical to what the server stored (a drift here 409s a re-pick).
 *
 *  Anything left outside the charset (spaces, punctuation, a script with no
 *  transliteration) collapses to ONE "-" rather than vanishing, so two folders
 *  whose names differ only in their separators still differ here. Returns "" only
 *  when nothing usable is left; every caller already falls back to "folder" or
 *  rejects it. */
export function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u0400-\u04ff]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? "")
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    // The 40-char cut can land on a separator; trim again so a stored name never
    // ends in "-" and two names cut at the same point stay byte-identical.
    .replace(/-+$/, "");
}
