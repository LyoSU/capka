import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";
import { lookup } from "mime-types";

/**
 * Single source of truth for how a file is presented across the UI — the icon,
 * its accent color, the tint behind it, and a human label. Previously this map
 * lived (and silently drifted) in three components; keep it here so a file looks
 * the same in the chat input, in a message artifact, and in the workspace panel.
 *
 * Classification is a hybrid: a small hand-kept list of dev/code extensions (where
 * the MIME database is absent or wrong — famously `.ts` → `video/mp2t`), then the
 * full MIME database (`mime-db`, ~1000 types) for the long tail. That gives broad
 * coverage without a giant hand-maintained extension list.
 *
 * The accent colors are intentionally Tailwind palette values, not theme tokens:
 * a file type's color is a stable brand marker (like GitHub's language colors),
 * not a themeable surface that should flip between light and dark.
 *
 * Which palette STEP is used, though, depends on what the color has to contrast
 * against — the two fields below follow different rules on purpose:
 *
 * - `color` tints a glyph sitting on the page background, so it needs one step
 *   per theme (`-600 dark:-400`). A single `-400` was used for both, which is
 *   ~1.6:1 on the light theme's warm background — effectively invisible, and the
 *   reason a code file's amber icon could not be seen at all in daylight mode.
 *   This pairing is what the rest of the app already does (see settings/activity).
 * - `badge` fills a chip that carries WHITE text, so it needs one FIXED dark step
 *   in both themes (`-700`). Pairing it per theme is what breaks it: white on
 *   `-400`/`-500` is under 2:1, and a theme token is worse still — the neutral
 *   fallback rides `--muted-foreground`, which is 0.46 light but 0.68 dark, so
 *   white-on-neutral would pass in one theme and vanish in the other.
 */
export type FileKind = {
  /** Key under `chat.preview.kind` — a localized noun, resolved by the caller.
   *  Held as a key rather than a string because this map is imported by client
   *  components that render it in the user's language. */
  labelKey: string;
  Icon: LucideIcon;
  /** Glyph accent, on the page background. Theme-paired — see the note above. */
  color: string;
  /** Tint behind a glyph. */
  bg: string;
  /** Fill for the extension chip, which carries white text. One fixed dark step
   *  in both themes — see the note above. */
  badge: string;
};

// Plain-text formats that read fine in a text viewer but the MIME db may label
// loosely. Kept explicit so they're always treated as text.
const TEXT_EXTS = new Set(["txt", "log", "csv", "tsv"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "csv", "numbers", "tsv"]);
const DOC_EXTS = new Set(["docx", "doc", "pdf", "odt", "rtf", "txt", "md", "log"]);
// Code extensions where MIME is absent or wrong (.ts → video/mp2t, .tsx/.jsx/.vue
// unknown), so this list must win before we consult MIME.
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "php", "css", "scss", "html", "vue", "svelte", "sh", "bash", "zsh",
  "sql", "c", "h", "cpp", "cc", "hpp", "json", "jsonc", "yaml", "yml", "toml",
  "xml", "graphql", "gql", "dockerfile", "ini", "env",
]);

const KIND = {
  // A folder never renders an extension chip, so its `badge` is only here to
  // satisfy the shape — the warm neutral, not `fill-primary`, which is near-black
  // in light and near-white in dark and would swallow the chip's white text.
  folder:  { labelKey: "folder",  Icon: FolderOpen,      color: "text-primary/70",                        bg: "bg-primary/10",       badge: "fill-stone-600" },
  image:   { labelKey: "image",   Icon: FileImage,       color: "text-violet-600 dark:text-violet-400",   bg: "bg-violet-500/10",    badge: "fill-violet-700" },
  sheet:   { labelKey: "sheet",   Icon: FileSpreadsheet, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10",   badge: "fill-emerald-700" },
  doc:     { labelKey: "doc",     Icon: FileText,        color: "text-blue-600 dark:text-blue-400",       bg: "bg-blue-500/10",      badge: "fill-blue-700" },
  code:    { labelKey: "code",    Icon: FileCode,        color: "text-amber-600 dark:text-amber-400",     bg: "bg-amber-500/10",     badge: "fill-amber-700" },
  video:   { labelKey: "video",   Icon: FileVideo,       color: "text-rose-600 dark:text-rose-400",       bg: "bg-rose-500/10",      badge: "fill-rose-700" },
  audio:   { labelKey: "audio",   Icon: FileAudio,       color: "text-fuchsia-600 dark:text-fuchsia-400", bg: "bg-fuchsia-500/10",   badge: "fill-fuchsia-700" },
  archive: { labelKey: "archive", Icon: FileArchive,     color: "text-orange-600 dark:text-orange-400",   bg: "bg-orange-500/10",    badge: "fill-orange-700" },
} satisfies Record<string, FileKind>;

/** Lowercased extension without the dot, or "" if the name has none. */
export function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/** Textual `application/*` types that are really plain text (read in the viewer). */
function isTextualMime(type: string): boolean {
  return (
    type.startsWith("text/") ||
    /^application\/(json|.*\+json|xml|.*\+xml|javascript|ecmascript|x-sh|x-shellscript|toml|x-yaml|yaml|sql|graphql|x-httpd-php|x-ndjson)$/.test(type)
  );
}

/**
 * How a file can be previewed in-app, or `null` if it has no viewer and should
 * just download. The single gate every file surface uses to decide whether a
 * tile is clickable (opens Quick Look). `markdown` renders rich; `text` covers
 * plain text AND code (Shiki-highlighted in the viewer). Real binaries
 * (docx/xlsx/zip), video and audio return `null`.
 */
export type PreviewKind = "image" | "pdf" | "markdown" | "html" | "text" | null;

export function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  // 1) Dev files first — MIME mislabels several (.ts → video/mp2t).
  if (ext === "md" || ext === "markdown") return "markdown";
  // HTML is rendered (not just syntax-highlighted), so it must win over the code
  // branch below — `html` is in CODE_EXTS for its icon, but its viewer differs.
  if (ext === "html" || ext === "htm") return "html";
  if (CODE_EXTS.has(ext) || TEXT_EXTS.has(ext)) return "text";
  // 2) Everything else: let the MIME database decide — this is what lets the
  //    viewer cover formats (avif, heic, tiff, many text/*…) we never hand-listed.
  const type = lookup(name) || "";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (isTextualMime(type)) return "text";
  return null;
}

/**
 * A coarse bucket for grouping files in the workspace panel — kept deliberately
 * small (Images / Documents / Other) so a non-technical user sees "my pictures"
 * and "my docs", not a dozen MIME categories. Derived from `fileKind` so the
 * buckets never drift from the icons.
 */
export type FileCategory = "image" | "document" | "other";

export function fileCategory(name: string): FileCategory {
  const k = fileKind(name);
  if (k === KIND.image) return "image";
  if (k === KIND.doc || k === KIND.sheet || k === KIND.code) return "document";
  return "other";
}

export function fileKind(name: string, isDir = false): FileKind {
  if (isDir) return KIND.folder;
  const ext = extOf(name);
  // Hand-kept sets first (specific icon/color, and MIME mislabels some).
  if (IMAGE_EXTS.has(ext)) return KIND.image;
  if (SHEET_EXTS.has(ext)) return KIND.sheet;
  if (DOC_EXTS.has(ext)) return KIND.doc;
  if (CODE_EXTS.has(ext)) return KIND.code;
  // Broaden via MIME so formats we didn't list still get a sensible icon.
  const type = lookup(name) || "";
  if (type.startsWith("image/")) return KIND.image;
  if (type.startsWith("video/")) return KIND.video;
  if (type.startsWith("audio/")) return KIND.audio;
  if (type === "application/pdf" || isTextualMime(type)) return KIND.doc;
  if (/zip|tar|gzip|compress|x-7z|x-rar/.test(type)) return KIND.archive;
  // Unrecognized: a warm neutral. The extension is not folded into the label the
  // way it used to be ("DB", "BIN") — it already shows on the thumbnail's chip and
  // in the filename, so a third copy only crowded the line.
  return { labelKey: "file", Icon: File, color: "text-muted-foreground", bg: "bg-muted/60", badge: "fill-stone-600" };
}
