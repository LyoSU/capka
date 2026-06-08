import {
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for how a file is presented across the UI — the icon,
 * its accent color, the tint behind it, and a human label. Previously this map
 * lived (and silently drifted) in three components; keep it here so a file looks
 * the same in the chat input, in a message artifact, and in the workspace panel.
 *
 * The accent colors are intentionally Tailwind palette values, not theme tokens:
 * a file type's color is a stable brand marker (like GitHub's language colors),
 * not a themeable surface that should flip between light and dark.
 */
export type FileKind = {
  label: string;
  Icon: LucideIcon;
  color: string;
  bg: string;
};

const DOC_EXTS = new Set(["docx", "doc", "pdf", "odt", "rtf", "txt", "md", "log"]);
const SHEET_EXTS = new Set(["xlsx", "xls", "csv", "numbers", "tsv"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java",
  "css", "html", "sh", "sql", "c", "cpp", "json", "yaml", "yml",
]);

/** Lowercased extension without the dot, or "" if the name has none. */
export function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function fileKind(name: string, isDir = false): FileKind {
  if (isDir) return { label: "Folder", Icon: FolderOpen, color: "text-primary/70", bg: "bg-primary/10" };
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return { label: "Image",       Icon: FileImage,       color: "text-violet-400",  bg: "bg-violet-500/10" };
  if (SHEET_EXTS.has(ext)) return { label: "Spreadsheet", Icon: FileSpreadsheet, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (DOC_EXTS.has(ext))   return { label: "Document",    Icon: FileText,        color: "text-blue-400",    bg: "bg-blue-500/10" };
  if (CODE_EXTS.has(ext))  return { label: "Code",        Icon: FileCode,        color: "text-amber-400",   bg: "bg-amber-500/10" };
  return { label: ext.toUpperCase() || "File", Icon: File, color: "text-muted-foreground", bg: "bg-muted/60" };
}
