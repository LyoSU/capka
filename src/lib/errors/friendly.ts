/**
 * Turn a raw LLM/provider error into something an ORDINARY user understands,
 * while keeping the technical detail for admins. unClaw is used by non-technical
 * staff on a shared admin-configured key, so a raw "402 insufficient credits"
 * (which only the admin can fix) must never be shown as-is to an end user.
 *
 * Centralized so every surface (worker, chat panel, API) maps errors the same.
 */
import { errorText } from "./message";

export type LLMErrorCategory =
  | "out_of_credits"
  | "invalid_key"
  | "rate_limited"
  | "model_unavailable"
  | "context_too_long"
  | "network"
  | "timed_out"
  | "provider_unresponsive"
  | "interrupted"
  | "unknown";

export interface FriendlyError {
  category: LLMErrorCategory;
  /** Shown to everyone — calm, non-technical, no keys/links/jargon. */
  userMessage: string;
  /** Shown only to admins — the raw provider detail, with the actionable bit. */
  adminDetail: string;
}

interface Rule {
  category: LLMErrorCategory;
  test: RegExp;
  userMessage: string;
}

// Order matters — first match wins.
const RULES: Rule[] = [
  {
    category: "out_of_credits",
    test: /\b(402|insufficient[_\s-]?(credits|quota|funds|balance)|out of credits|requires more credits|can only afford|exceeded your current quota|billing)\b/i,
    userMessage:
      "The assistant is temporarily unavailable — the AI account is out of credit. Your administrator needs to top it up.",
  },
  {
    category: "invalid_key",
    test: /\b(401|invalid[_\s-]?api[_\s-]?key|incorrect api key|unauthorized|no auth credentials|authentication|api key not valid|permission denied)\b/i,
    userMessage:
      "The assistant isn't connected right now. Your administrator needs to check the AI provider settings.",
  },
  {
    category: "rate_limited",
    test: /\b(429|rate[_\s-]?limit|too many requests|overloaded|capacity)\b/i,
    userMessage: "The assistant is busy right now. Please try again in a few moments.",
  },
  {
    category: "context_too_long",
    test: /\b(context[_\s-]?length|maximum context|context window|too many tokens|reduce the length|prompt is too long)\b/i,
    userMessage:
      "This conversation got too long for the model. Start a new chat or shorten your message and try again.",
  },
  {
    category: "model_unavailable",
    test: /\b(model).*(not found|not a valid model|does not exist|is not available|no endpoints|unsupported)\b/i,
    userMessage:
      "The selected AI model isn't available right now. Try a different model, or ask your administrator.",
  },
  {
    category: "network",
    test: /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error|socket hang up|timed out|timeout)\b/i,
    userMessage: "Couldn't reach the AI service. Please try again in a moment.",
  },
];

const DEFAULT_USER_MESSAGE =
  "Something went wrong while generating a response. Please try again — if it keeps happening, let your administrator know.";

/** Classify a raw error string/Error into a user-friendly, role-aware shape. */
export function classifyLLMError(raw: unknown): FriendlyError {
  const detail = errorText(raw);
  const rule = RULES.find((r) => r.test.test(detail));
  return {
    category: rule?.category ?? "unknown",
    userMessage: rule?.userMessage ?? DEFAULT_USER_MESSAGE,
    adminDetail: detail || DEFAULT_USER_MESSAGE,
  };
}

/**
 * Some models/providers reject image/file inputs outright. The wording varies
 * by provider and is NOT a stable error code, so the known shapes are matched
 * here in ONE place instead of being scattered as inline substring checks in
 * the runner. On a hit, the runner retries the turn once with native files
 * stripped. Deliberately tied to image/file/vision phrasing (not a bare
 * "unsupported") so an unrelated capability error doesn't strip attachments.
 */
export function isVisionUnsupportedError(raw: unknown): boolean {
  const detail = errorText(raw);
  return (
    /\b(image input|multimodal|image_url)\b/i.test(detail) ||
    /\b(no|without|lacks?|cannot|can'?t|doesn'?t|does not|not)\b[^.]{0,40}\b(vision|images?|multimodal)\b/i.test(
      detail,
    ) ||
    /\b(vision|images?)\b[^.]{0,30}\b(not supported|unsupported|not available)\b/i.test(detail)
  );
}

/**
 * A model that doesn't support reasoning/thinking rejects a request that asks
 * for it. The runner enables reasoning optimistically (so it "just works" on
 * capable models) and retries once WITHOUT it on a hit. Tied to thinking/
 * reasoning phrasing so an unrelated capability error doesn't silently strip
 * reasoning — it requires both a reasoning keyword and an "unsupported" verb.
 */
export function isReasoningUnsupportedError(raw: unknown): boolean {
  const detail = errorText(raw);
  return (
    /\b(thinking|reasoning|reasoning_effort|reasoningeffort|budget_?tokens|reasoning_?summary)\b/i.test(
      detail,
    ) &&
    /\b(not supported|unsupported|not available|invalid|unknown|unexpected|unrecognized|does ?n'?t support|do(es)? not support|cannot|not permitted|not allowed)\b/i.test(
      detail,
    )
  );
}

/**
 * Any native attachment a provider rejects — image/vision, audio, or file/PDF.
 * A superset of `isVisionUnsupportedError`: the runner optimistically trusts the
 * catalog's per-model modalities (which can over-claim for a custom backend), so
 * a runtime rejection of ANY attachment type must trigger the same strip-and-retry
 * — not just images. Tied to attachment phrasing so an unrelated capability error
 * doesn't strip files. The matching `input_audio` / `image_url` content-type names
 * are the most reliable signal across OpenAI-compatible gateways.
 */
export function isModalityUnsupportedError(raw: unknown): boolean {
  if (isVisionUnsupportedError(raw)) return true;
  const detail = errorText(raw);
  return (
    /\b(input_audio|audio_url|audio input|file input|file_data|document input)\b/i.test(detail) ||
    /\b(audio|file|document|pdf|attachment|content type)\b[^.]{0,40}\b(not supported|unsupported|not available|invalid|not allowed|cannot|can'?t)\b/i.test(
      detail,
    ) ||
    /\b(no|without|lacks?|cannot|can'?t|doesn'?t|does not|not)\b[^.]{0,40}\b(audio|file|document|pdf)\b/i.test(
      detail,
    )
  );
}

/**
 * The conversation overran the model's context window. Reuses the same rules as
 * classifyLLMError so the detection stays in one place. The runner uses this to
 * trigger a mechanical emergency trim + retry instead of surfacing a dead end —
 * note the prefix is by definition too big to summarize with an LLM here, so the
 * reactive path must shrink mechanically, not via compaction.
 */
export function isContextOverflowError(raw: unknown): boolean {
  return classifyLLMError(raw).category === "context_too_long";
}

/**
 * A provider hiccup worth re-streaming (continuation), vs. a fatal config/auth
 * error re-streaming can't fix. classifyLLMError has no explicit 5xx rule (they
 * fall to "unknown"), so server-error shapes are matched directly here.
 */
export function isTransientError(raw: unknown): boolean {
  const { category } = classifyLLMError(raw);
  if (category === "network" || category === "rate_limited") return true;
  return /\b(50\d|51\d|52\d|internal server error|bad gateway|service unavailable|temporarily unavailable|server error)\b/i.test(
    errorText(raw),
  );
}

/**
 * Server-enforced run deadline. Used directly (not via the regex rules, which
 * would mis-match a generic "timeout" as a network error) when a task exceeds
 * its wall-clock budget — a live worker stuck on a hung tool/LLM call.
 */
export const TIMED_OUT_ERROR: FriendlyError = {
  category: "timed_out",
  userMessage:
    "This task took too long and was stopped. Please try again, or break it into smaller steps.",
  adminDetail: "Task exceeded the maximum run time and was aborted by the server.",
};

/**
 * The provider accepted the request but stopped streaming — no tokens for long
 * enough that the stall watchdog gave up after retrying. Distinct from a clean
 * timeout (the model never produced ANYTHING, vs. ran out of time mid-work) and
 * from `network` (the connection opened fine; the gateway just went quiet). The
 * actionable advice for a non-technical user is to retry or switch models, since
 * one provider being flaky is exactly what a model switch routes around.
 */
export const PROVIDER_UNRESPONSIVE_ERROR: FriendlyError = {
  category: "provider_unresponsive",
  userMessage:
    "The AI model stopped responding. Please try again — if it keeps happening, switch to a different model.",
  adminDetail: "Provider streamed no output before the stall timeout; retries were exhausted.",
};

/**
 * The worker running this turn lost its lease — the server restarted, or the
 * zombie-reconciler took the task over because a heartbeat was late. This is a
 * crash/interruption, NOT a user cancellation, so it must finalize as "failed"
 * (with a retry nudge), never as a clean "cancelled".
 */
export const INTERRUPTED_ERROR: FriendlyError = {
  category: "interrupted",
  userMessage: "This task was interrupted and didn't finish. Please try again.",
  adminDetail: "Worker lost its task lease (server restart or zombie reconciliation); the turn was aborted mid-run.",
};
