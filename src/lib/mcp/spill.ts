import { uploadFile } from "@/lib/sandbox/client";
import { log } from "@/lib/log";

/** Where an oversized MCP result is parked in the session workspace. Shares the
 *  `.capka/output` root with the sandbox capture logs (dot-hidden in the UI). */
const MCP_OUTPUT_DIR = ".capka/output/mcp";

/** mimeType → file extension allowlist. The extension is chosen HERE, never taken
 *  from the (untrusted) server-supplied name/mimeType, so a crafted `mimeType`
 *  can't smuggle a path or a surprising extension into the workspace. */
const EXT_BY_MIME: Record<string, string> = {
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function safeExt(mimeType?: string): string {
  if (mimeType) {
    const ext = EXT_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()];
    if (ext) return ext;
    if (mimeType.startsWith("text/")) return "txt";
  }
  return "bin";
}

/**
 * Park an oversized MCP result in the session workspace so the model can retrieve
 * it with `read_file`/grep instead of us flooding the model context AND Postgres
 * with the whole blob every turn. Written off-disk through the controller's file
 * API (HMAC token), so it needs no live container — a chat that only uses remote
 * MCP never spins a sandbox just to store a result.
 *
 * Returns the workspace path (as the model should reference it) or `null` when it
 * can't be persisted — no session key, the workspace quota is full (413), or a
 * controller error. Callers MUST degrade gracefully on null, never throw: an
 * untrusted connector returning a huge blob is not a reason to fail the turn.
 *
 * SECURITY: the filename is generated here (timestamp + random) with an extension
 * from `EXT_BY_MIME`. The server-supplied name/mimeType never reaches the path.
 * The controller's path-safety layer is a second, independent guard.
 */
export async function spillToWorkspace(
  sessionKey: string | undefined,
  userId: string | undefined,
  data: { bytes: Buffer; mimeType?: string },
): Promise<string | null> {
  if (!sessionKey) return null;
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt(data.mimeType)}`;
  try {
    // Wrap in a fresh Uint8Array: a Node Buffer's backing store types as
    // ArrayBufferLike (may be SharedArrayBuffer), which isn't a valid BlobPart.
    const file = new File([new Uint8Array(data.bytes)], name, { type: data.mimeType || "application/octet-stream" });
    await uploadFile(sessionKey, MCP_OUTPUT_DIR, file, userId);
    return `/workspace/${MCP_OUTPUT_DIR}/${name}`;
  } catch (e) {
    // Quota (413) or controller error — the result just won't be recoverable.
    log.warn("mcp result spill failed", { sessionKey, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
