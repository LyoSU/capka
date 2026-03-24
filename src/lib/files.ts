import { resolve } from "path";
import { lstat, realpath } from "fs/promises";

function userBase(userId: string, projectId?: string): string {
  return resolve(`./data/storage/${userId}${projectId ? `/${projectId}` : ""}`);
}

export function resolveUserPath(
  userId: string,
  projectId?: string,
  relativePath?: string,
): string {
  const base = userBase(userId, projectId);
  const resolved = resolve(base, relativePath || ".");
  if (!resolved.startsWith(base)) throw new Error("Path traversal detected");
  return resolved;
}

/** Verify resolved path is not a symlink pointing outside the sandbox */
export async function assertNoSymlinkEscape(resolved: string, userId: string, projectId?: string): Promise<void> {
  const base = userBase(userId, projectId);
  const info = await lstat(resolved);
  if (info.isSymbolicLink()) {
    const real = await realpath(resolved);
    if (!real.startsWith(base)) throw new Error("Symlink escape detected");
  }
}

/** Sanitize filename for Content-Disposition header */
export function sanitizeFilename(name: string): string {
  return name.replace(/["\\\n\r]/g, "_");
}

/** Content types that can execute JS when served inline */
export const DANGEROUS_CONTENT_TYPES = new Set(["text/html", "image/svg+xml"]);

const MIME_MAP: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
};

export function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}
