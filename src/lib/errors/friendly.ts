/**
 * Turn a raw LLM/provider error into something an ORDINARY user understands,
 * while keeping the technical detail for admins. unClaw is used by non-technical
 * staff on a shared admin-configured key, so a raw "402 insufficient credits"
 * (which only the admin can fix) must never be shown as-is to an end user.
 *
 * Centralized so every surface (worker, chat panel, API) maps errors the same.
 */
export type LLMErrorCategory =
  | "out_of_credits"
  | "invalid_key"
  | "rate_limited"
  | "model_unavailable"
  | "context_too_long"
  | "network"
  | "timed_out"
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
  const detail =
    raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw ?? "");
  const rule = RULES.find((r) => r.test.test(detail));
  return {
    category: rule?.category ?? "unknown",
    userMessage: rule?.userMessage ?? DEFAULT_USER_MESSAGE,
    adminDetail: detail || DEFAULT_USER_MESSAGE,
  };
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
