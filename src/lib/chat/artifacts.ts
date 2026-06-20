/**
 * "Artifacts" are the workspace files an assistant turn explicitly refers to by
 * their `/workspace/…` path in its reply. The web transcript turns these into
 * file tiles; the Telegram channel sends them as documents. Both must agree on
 * what counts as referenced, so the detection lives here, in one place.
 *
 * Only paths the model actually names are artifacts — NOT every file touched
 * during the run — so an incidental temp file or an unrelated edit is never
 * surfaced.
 */

// Matches `/workspace/<relative path>.<ext>`, capturing the relative path. The
// character class allows nested dirs, spaces, parens and Ukrainian letters in
// file names, but stops before a second `/workspace/` so adjacent references
// don't merge into one.
export const WORKSPACE_PATH_RE =
  /\/workspace\/((?:(?!\/workspace\/)[\w/.А-Яа-яІіЇїЄєҐґ_\- ()])+\.\w+)/g;

/**
 * A captured path is safe only if it stays inside the workspace: relative, with
 * no `..` (or bare `.`) segments. The text is the model's reply — a prompt-
 * injected or buggy turn could emit `/workspace/../../etc/passwd.txt`, which
 * would otherwise become a clickable tile that reads a host file through the
 * download endpoint. Reject traversal here, at the one shared source, so both
 * the web tiles and the Telegram documents stay anchored to the workspace.
 */
function isInsideWorkspace(rel: string): boolean {
  if (rel.startsWith("/")) return false; // absolute — not workspace-relative
  return rel.split("/").every((seg) => seg !== ".." && seg !== ".");
}

/** Unique workspace-relative paths the text references, in first-seen order. */
export function extractWorkspacePaths(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(WORKSPACE_PATH_RE), (m) => m[1]))].filter(isInsideWorkspace);
}
