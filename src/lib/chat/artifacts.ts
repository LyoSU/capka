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

// What a workspace-relative path may be made of: letters, digits and combining
// marks in ANY script, plus the separators and punctuation a file name uses.
// Unicode properties rather than an explicit alphabet — the class used to spell
// out Latin + Ukrainian, so a file the agent named in Chinese, Greek or Georgian
// silently stopped being an artifact. Deliberately excludes every shell
// metacharacter, because the archive route below feeds these paths to a command.
const PATH_CHARS = String.raw`\p{L}\p{N}\p{M}/._\- ()`;

// Matches `/workspace/<relative path>.<ext>`, capturing the relative path. Stops
// before a second `/workspace/` so adjacent references don't merge into one.
// Global + unicode: build clones with `freshWorkspacePathRe()`, never by copying
// `.source` alone (dropping `u` turns `\p{L}` into a literal and quietly breaks
// every non-Latin name).
export const WORKSPACE_PATH_RE = new RegExp(
  String.raw`/workspace/((?:(?!/workspace/)[${PATH_CHARS}])+\.\w+)`,
  "gu",
);

/** A stateless copy of {@link WORKSPACE_PATH_RE} for callers that `exec` in a
 *  loop — the exported one is global, so its `lastIndex` is shared state. */
export function freshWorkspacePathRe(): RegExp {
  return new RegExp(WORKSPACE_PATH_RE.source, WORKSPACE_PATH_RE.flags);
}

/** Whole-string charset check for a workspace-relative path supplied by a client
 *  (the archive endpoint shell-quotes these). Charset only: it says nothing about
 *  traversal — callers must reject `..` themselves, since `.` is a legal char. */
export const SAFE_WORKSPACE_PATH_RE = new RegExp(`^[${PATH_CHARS}]+$`, "u");

/**
 * A captured path is safe only if it stays inside the workspace: relative, with
 * no `..` (or bare `.`) segments. The text is the model's reply — a prompt-
 * injected or buggy turn could emit `/workspace/../../etc/passwd.txt`, which
 * would otherwise become a clickable tile that reads a host file through the
 * download endpoint. Reject traversal here, at the one shared source, so both
 * the web tiles and the Telegram documents stay anchored to the workspace.
 */
export function isSafeWorkspaceRel(rel: string): boolean {
  if (rel.startsWith("/")) return false; // absolute — not workspace-relative
  return rel.split("/").every((seg) => seg !== ".." && seg !== ".");
}

/** Unique workspace-relative paths the text references, in first-seen order. */
export function extractWorkspacePaths(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(WORKSPACE_PATH_RE), (m) => m[1]))].filter(isSafeWorkspaceRel);
}

/** The safe, decoded workspace-relative path for a `/workspace/…` href, or null
 *  if it isn't one or would escape the workspace. Used to turn an inline
 *  `/workspace/` link the model wrote into a clickable file chip. Models often
 *  percent-encode non-ASCII (Cyrillic) file names in link URLs, so decode first
 *  — both to show a readable name and to address the real file. Decoding before
 *  the safety check also stops an encoded `..` (e.g. `%2e%2e`) from slipping
 *  past traversal rejection. */
export function workspaceRelFromHref(href: string): string | null {
  const prefix = "/workspace/";
  if (!href.startsWith(prefix)) return null;
  let rel = href.slice(prefix.length);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null; // malformed encoding — reject rather than guess
  }
  return rel && isSafeWorkspaceRel(rel) ? rel : null;
}
