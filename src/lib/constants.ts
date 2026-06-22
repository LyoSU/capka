export const MEMORY_TYPES = ["fact", "preference", "context"] as const;

// ── File attachments ─────────────────────────────────────────

/** Metadata for a file uploaded to the sandbox workspace */
export type FileRef = { name: string; type: string };

/** Max individual file size for native multimodal injection */
export const MAX_NATIVE_FILE_BYTES = 20 * 1024 * 1024;

/** Max total bytes for all native multimodal files combined */
export const MAX_NATIVE_TOTAL_BYTES = 50 * 1024 * 1024;

/** Extension → MIME type map for common native-multimodal file types */
const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/**
 * Return a reliable MIME type for a file.
 * - Uses the browser-provided type if non-empty and plausible (contains `/`)
 * - Falls back to extension-based detection for known multimodal types
 * - Returns empty string for unknown types (caller treats as non-native)
 */
export function inferMimeType(filename: string, browserType: string): string {
  if (browserType && browserType.includes("/")) return browserType;
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  const ext = filename.slice(dot).toLowerCase();
  return EXT_MIME[ext] ?? "";
}

/** Default model list filter — overridable via settings UI */
export const DEFAULT_MODEL_MIN_CONTEXT = 100_000;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Format bytes to human-readable string */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`;
}
