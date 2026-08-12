/**
 * What a turn produced, in two tiers of confidence.
 *
 * TIER ONE — "artifacts": the workspace files the reply names by their
 * `/workspace/…` path (`extractWorkspacePaths`). The model mentions what it
 * considers the result, which makes this a free and surprisingly good relevance
 * signal. The web shows these as file tiles; Telegram sends them as documents.
 *
 * TIER TWO — "touched files": everything else that changed on disk during the
 * turn's tool calls (`selectTouchedFiles`). This exists because tier one has a
 * silent failure: the most common way Capka produces a file is a python script
 * writing an .xlsx, and if the reply just says "Done!" the user is shown nothing
 * at all. The listing has no taste, though — it cannot tell `Звіт Q3.xlsx` from
 * `~$Звіт Q3.xlsx` — so tier two is deliberately kept SEPARATE and folded away
 * rather than merged into tier one. That keeps the "Files · N" heading an honest
 * promise, keeps "Download all" pointed at the result, and means we never have to
 * maintain an ignore-list guessing which files are junk (a list that would
 * eventually hide a file someone needed).
 *
 * Both tiers live here so the web and Telegram can never disagree about them.
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

/** One entry of a workspace listing — the subset of the controller's `FileEntry`
 *  that tier-two selection actually reads. */
export type WorkspaceEntry = {
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
};

/** When one tool call started and finished, in epoch ms. */
export type ToolWindow = { start: number; end: number };

/** Filesystem timestamps round to the second and the sandbox controller's clock
 *  is not the platform's, so a write that lands exactly on a boundary must not be
 *  lost to sub-second skew. Small enough that it cannot reach into the gap
 *  between two tool calls (the model spends far longer than this thinking). */
const MTIME_SLACK_MS = 1_500;

/** Past this many, the fold has stopped being a list and become a file browser —
 *  and the row would start to weigh on every message read from the DB. */
const MAX_TOUCHED = 12;

/**
 * Tier two: files whose mtime falls inside one of the turn's tool windows.
 *
 * Windowing (rather than a plain before/after diff) is what keeps a shared
 * workspace honest: chats in one project all write to the same folder, so a
 * parallel chat or a scheduled automation would otherwise have its output
 * credited to whoever happened to answer next. Only the moments THIS turn was
 * executing a tool can belong to it.
 *
 * `named` is tier one; anything already shown there is dropped, so a file is
 * never presented twice in one message.
 */
export function selectTouchedFiles(
  entries: WorkspaceEntry[],
  windows: ToolWindow[],
  named: string[],
): string[] {
  if (windows.length === 0) return [];
  const already = new Set(named);
  return entries
    .filter((e) => !e.isDirectory && e.modifiedAt && !already.has(e.path) && isSafeWorkspaceRel(e.path))
    .map((e) => ({ path: e.path, at: Date.parse(e.modifiedAt as string) }))
    .filter(
      (e) =>
        Number.isFinite(e.at) &&
        windows.some((w) => e.at >= w.start - MTIME_SLACK_MS && e.at <= w.end + MTIME_SLACK_MS),
    )
    // Newest first: the turn writes its real output last, so even folded away
    // the thing the user wants is the first one they see on expanding.
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_TOUCHED)
    .map((e) => e.path);
}

/** Below this, a basename is too generic to be evidence: "a.c" appears in prose
 *  by accident, and a false promotion puts scratch files in the tier whose whole
 *  job is to contain only results. */
const MIN_DISTINCTIVE_BASENAME = 5;

/**
 * Split the turn's touched files by whether the reply mentions them at all.
 *
 * `extractWorkspacePaths` only sees a full `/workspace/…` path, which quietly
 * assumes a model disciplined enough to write one. Weaker models — and Capka lets
 * an admin point the product at whatever is cheap — say "saved it to report.xlsx"
 * or just "done". Matching on the BASENAME instead covers both: capable models
 * keep working exactly as before, and a bare mention now counts as naming the
 * file, so tier one stays the result and the scratch files stay folded.
 *
 * Without this, the weakest models fall all the way through to "the reply named
 * nothing", promoting every touched file — the undifferentiated list this design
 * exists to avoid, arriving precisely where the user is least equipped to read it.
 */
export function splitTouchedByMention(
  touched: string[],
  text: string,
): { mentioned: string[]; rest: string[] } {
  // Case-insensitive: the filesystem is case-sensitive but a model retyping a
  // name in a sentence is not, and this is a relevance hint, not an identity check.
  const haystack = text.toLowerCase();
  const mentioned: string[] = [];
  const rest: string[] = [];
  for (const path of touched) {
    const base = (path.split("/").pop() || path).toLowerCase();
    const named = base.length >= MIN_DISTINCTIVE_BASENAME && haystack.includes(base);
    (named ? mentioned : rest).push(path);
  }
  return { mentioned, rest };
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
