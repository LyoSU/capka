/**
 * Importing a shared conversation from another AI service (Claude, ChatGPT,
 * Gemini, Grok) into a fresh Capka chat, so a user can bring context they built
 * elsewhere and keep working here with any model this instance has configured.
 *
 * The pipeline has three isolated stages, each with one job:
 *  1. `detect`   — is this pasted text a supported share link? (pure; runs on
 *                  both the client composer and the server, so they never
 *                  disagree about what counts as importable).
 *  2. render     — a headless browser inside the sandbox pulls the RAW provider
 *                  payload (`render.ts`). The untrusted page is fetched and
 *                  executed there, never in the platform process.
 *  3. `parse`    — pure functions turn that raw payload into `ImportedMessage[]`
 *                  and cap/sanitize it (`parse.ts`; fixture-tested).
 *
 * Imported text is UNTRUSTED user content. It becomes ordinary user/assistant
 * messages with zero elevated status — it may contain prompt-injection ("ignore
 * your rules…") and must never be treated as a system instruction.
 */

/** Services we can import a public share link from. */
export type ImportSource = "claude" | "chatgpt" | "gemini" | "grok";

/** A single turn lifted from the source conversation. Roles collapse to the two
 *  Capka stores; anything else (tool/system) is dropped upstream. */
export interface ImportedMessage {
  role: "user" | "assistant";
  content: string;
}

/** The normalized result of importing one shared conversation. */
export interface SharedChatImport {
  source: ImportSource;
  /** The source conversation's title, if it had one. */
  title: string | null;
  messages: ImportedMessage[];
  /** True when the source had more messages than we kept (hit the cap). */
  truncated: boolean;
  /** True when the source contained attachments/images/tool calls we did not
   *  import (text-only MVP) — drives the "attachments weren't imported" note. */
  droppedRichContent: boolean;
}

/** A detected share link: which service, and the canonicalized URL to fetch. */
export interface DetectedShareLink {
  source: ImportSource;
  url: string;
}

/**
 * Machine-readable failure reasons. The server sends the code; the client maps it
 * to a localized, calm sentence (never a stack trace). Keep in sync with the
 * `chat.import.error.*` message keys.
 */
export type ImportErrorCode =
  | "NETWORK_DISABLED" // this instance runs the sandbox with egress off
  | "PLAYWRIGHT_MISSING" // sandbox image lacks the headless browser
  | "BLOCKED" // the source blocked the fetch (bot challenge)
  | "NOT_FOUND" // the share link is dead / private / mistyped
  | "FORMAT_CHANGED" // the source changed its page shape; parser needs an update
  | "EMPTY" // fetched fine, but no importable text turns were found
  | "RENDER_FAILED"; // anything else (timeout, launch failure, controller blip)

// ── Caps (defense-in-depth; applied on both preview and commit) ──────────────

/** Keep an import bounded so a huge conversation can't blow up the workspace or
 *  the first turn's context. A dropped tail is surfaced as `truncated`. */
export const MAX_IMPORT_MESSAGES = 200;
/** Per-message hard cap. Longer messages are clipped (with an ellipsis marker). */
export const MAX_IMPORT_MESSAGE_CHARS = 100_000;
/** Whole-import ceiling, so many medium messages can't sum to something huge. */
export const MAX_IMPORT_TOTAL_CHARS = 600_000;
