export const MEMORY_TYPES = ["fact", "preference", "context"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Format bytes to human-readable string */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`;
}
