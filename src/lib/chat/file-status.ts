/**
 * The single way every surface classifies a workspace-file fetch. The chat shows
 * a file in three places — the Quick Look viewers, the inline `/workspace/…`
 * chips, and the artifact tiles — and they MUST read a controller response the
 * same way, so the verdict lives here, in one function.
 *
 *  - `ok`        — the file is there and readable.
 *  - `gone`      — 404: no such file. The workspace is scratch space, so an old
 *                  chat's file may be deleted; just as often the model named a
 *                  `/workspace/…` path it never actually created (a hallucination).
 *  - `temporary` — 5xx / network blip: the controller is momentarily unreachable;
 *                  the file probably exists, so this is retryable, not a miss.
 *  - `error`     — any other status: a hard failure worth surfacing plainly.
 */
export type FileStatus = "ok" | "gone" | "temporary" | "error";

export function fileStatusFromHttp(status: number): FileStatus {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "gone";
  if (status >= 500) return "temporary";
  return "error";
}
