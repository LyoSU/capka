/**
 * Turn a raw LLM/provider error into something an ORDINARY user understands,
 * while keeping the technical detail for admins. Capka is used by non-technical
 * staff on a shared admin-configured key, so a raw "402 insufficient credits"
 * (which only the admin can fix) must never be shown as-is to an end user.
 *
 * Centralized so every surface (worker, chat panel, API) maps errors the same.
 */
import { errorText } from "./message";
import { stripNul } from "@/lib/tasks/sanitize";

/**
 * Every failure bucket a turn can end in. Exported as a VALUE (not just a union)
 * because two other places have to enumerate it: the chat bubble's localized
 * rendering and the `errors.llm.*` catalog parity test. Both used to keep their
 * own hand-written copy, which is how `provider_unresponsive` ended up with no
 * translation at all.
 */
export const LLM_ERROR_CATEGORIES = [
  "out_of_credits",
  "invalid_key",
  "rate_limited",
  "model_unavailable",
  "context_too_long",
  "content_blocked",
  "network",
  "timed_out",
  "timed_out_partial",
  "provider_unresponsive",
  "provider_unresponsive_partial",
  "response_truncated",
  "interrupted",
  "interrupted_partial",
  "unknown",
] as const;

export type LLMErrorCategory = (typeof LLM_ERROR_CATEGORIES)[number];

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
    // Also covers reseller/gateway quota gates that aren't a quick retry: a
    // weekly/monthly usage cap ("resets in N days") or a per-day unlock gate
    // ("check-in required to unlock your key"). Bucketed here (not rate_limited)
    // so the runner does NOT treat them as transient and waste retry attempts.
    test: /\b(402|insufficient[_\s-]?(credits|quota|funds|balance)|out of credits|requires more credits|can only afford|exceeded your current quota|billing|usage[_\s-]?limit (reached|exceeded)|check[_\s-]?in required|unlock your key)\b/i,
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
    // A shared gateway pool momentarily full ("upstream load … saturated"); a
    // transient condition, so retrying (the runner re-streams) is the right move.
    // `saturated` is anchored to a pool/upstream context so it doesn't match an
    // unrelated "image is saturated"/"market is saturated" and force a retry.
    test: /\b(429|rate[_\s-]?limit|too many requests|overloaded|capacity|upstream load)\b|\b(upstream|group|pool|channel)\b[^.]{0,30}\bsaturated\b/i,
    userMessage: "The assistant is busy right now. Please try again in a few moments.",
  },
  {
    category: "context_too_long",
    // The last alternative is Google's: "The input token count (N) exceeds the
    // maximum number of tokens allowed (M)" names neither context nor length.
    test: /\b(context[_\s-]?length|maximum context|context window|too many tokens|reduce the length|prompt is too long|maximum number of tokens allowed)\b/i,
    userMessage:
      "This conversation got too long for the model. Start a new chat or shorten your message and try again.",
  },
  {
    category: "content_blocked",
    // A provider's content-safety engine refusing outright — DeepSeek's "Content
    // Exists Risk", Azure's content-management policy / ResponsibleAIPolicyViolation,
    // OpenAI's content_filter + safety system, Gemini's PROHIBITED_CONTENT. Placed
    // AFTER credits/auth/rate-limit so an admin-actionable or transient failure
    // that happens to name a policy engine still wins. Not transient: retrying the
    // same prompt fails the same way, so the message asks for a rephrase instead
    // of "try again in a moment".
    // The second group has no trailing \b on purpose: Azure ships these as one
    // camelCase token ("ResponsibleAIPolicyViolation"), where a word boundary
    // after "ai" can never match.
    test: /\b(content[_\s-]?(filter|policy|management)|content exists risk|prohibited[_\s-]?content|safety (system|filter|settings)|unsafe content|jailbreak|flagged (by|as)|moderation)\b|\b(responsible[_\s-]?ai|policy[_\s-]?violation)|内容[^。]{0,12}(违规|风险|审核)|敏感内容/i,
    userMessage:
      "The AI provider wouldn't answer this one for content-safety reasons. Try rephrasing it, or switch to a different model.",
  },
  {
    category: "model_unavailable",
    // Adds reseller shapes: a deprecated model ("migrate to …") and a request the
    // gateway can't serve in the chosen wire format ("not supported for format …").
    test: /\b(model).*(not found|not a valid model|does not exist|is not available|no endpoints|unsupported|not supported|deprecated|no longer (available|supported))\b/i,
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
  // Strip NUL: a raw provider/gateway error can carry binary bytes, and this
  // detail is written to jsonb message metadata + the tasks.error column — an
  // un-stripped NUL would throw on the very write meant to persist the failure.
  const detail = stripNul(errorText(raw));
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
    /\b(thinking|reasoning|reasoning_effort|reasoningeffort|budget_?tokens|reasoning_?summary|reasoning_?config)\b/i.test(
      detail,
    ) &&
    /\b(not supported|unsupported|not available|invalid|unknown|unexpected|unrecognized|does ?n'?t support|do(es)? not support|cannot|not permitted|not allowed)\b/i.test(
      detail,
    )
  );
}

/** Every effort token we recognize; anything else in an error message is noise. */
const EFFORT_TOKEN = /\b(none|default|minimal|low|medium|high|xhigh|max)\b/gi;

/**
 * The model DOES reason, but not at the level we asked for — it rejects the
 * VALUE of `reasoning_effort`, and helpfully enumerates what it would accept:
 *
 *   Kimi K3:  "reasoning_effort must be low, high, or max"
 *   Groq:     "reasoning_effort must be one of none or default"
 *   OpenAI:   "Invalid value: 'medium'. Supported values are: 'low', 'high'"
 *
 * There is no portable enum (see models/thinking.ts), and the wire error carries
 * no machine-readable field — Moonshot returns `invalid_request_error` with an
 * EMPTY `param` — so the accepted set has to be read out of the prose. On a hit
 * the runner retries once with a legal value and remembers the enum on the model
 * row, so the negotiation costs one request per model, ever.
 *
 * Returns the accepted values, or null when this isn't that error. Deliberately
 * narrow on two axes so it can't fire on the wrong thing:
 *   - the message must name the `reasoning_effort` field itself, and
 *   - only the enumerating phrasings count ("must be", "one of", "expected",
 *     "supported/allowed/valid values"), never a bare rejection.
 * That's what keeps it off DeepSeek's opposite demand ("reasoning_content must
 * be passed back"), where retrying with a different effort would loop the turn.
 */
export function parseAllowedEfforts(raw: unknown): string[] | null {
  const detail = errorText(raw);
  if (!/reasoning[_ ]?effort/i.test(detail)) return null;
  // Take the text AFTER the enumerating phrase — otherwise the rejected value
  // ("Invalid value: 'medium'") would be collected as an accepted one.
  // The leading \b matters more than it looks: without it, "Invalid value:
  // 'medium'" matches the `valid values?` alternative *inside* "Invalid", and the
  // REJECTED value gets collected as an accepted one.
  const enumeration =
    /\b(?:must be(?:\s+(?:one|any)\s+of)?|can(?:\s+only)?\s+be|one of|expected|(?:supported|allowed|valid|accepted|permitted)\s+values?(?:\s+are)?)\s*:?\s*(.{0,120})/i.exec(
      detail,
    );
  if (!enumeration) return null;
  const found = enumeration[1].match(EFFORT_TOKEN);
  if (!found) return null;
  const values = Array.from(new Set(found.map((v) => v.toLowerCase())));
  // A single value is usually the REJECTED one quoted back at us rather than an
  // enumeration ("reasoning_effort medium is invalid"), and acting on it would
  // pin the model to a value it just refused. Needs at least a real list.
  return values.length > 1 ? values : null;
}

/**
 * A DIFFERENT failure from `isReasoningUnsupportedError`: here the model DID
 * reason, but the backend rejects the model's OWN prior `reasoning_content` when
 * it's echoed back in history. `@ai-sdk/openai-compatible` serializes past
 * reasoning parts as `reasoning_content` unconditionally (vercel/ai#15042), and
 * some OpenAI-compatible backends (Cerebras — often behind a LiteLLM proxy, so we
 * can't tell up front) accept that field only on OUTPUT and 400 on input. On a
 * hit the runner strips reasoning from history and re-streams once. Tied to the
 * literal wire field `reasoning_content` + a rejection verb so it can't fire on
 * DeepSeek's opposite demand ("reasoning_content ... must be passed back"), where
 * stripping would loop the turn.
 */
export function isReasoningEchoRejectedError(raw: unknown): boolean {
  const detail = errorText(raw);
  return (
    /reasoning_content/i.test(detail) &&
    /\b(unsupported|not supported|not allowed|not permitted|invalid|unexpected|unrecognized|unknown)\b/i.test(
      detail,
    )
  );
}

/**
 * The endpoint refuses `stream_options: {include_usage: true}` — the request we
 * make to get token counts back on a stream (see providers/stream-usage.ts for why
 * it has to be asked for, and why optimistically).
 *
 *   OpenAI-style proxy:  "Unrecognized request argument supplied: stream_options"
 *   pydantic gateway:    {"loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}
 *   xAI / Databricks:    "Argument not supported on this model: stream_options"
 *
 * Narrow on the same two axes as the classifiers above — it must name the field
 * AND carry a rejection verb — because a false positive costs more than a missed
 * one: on a hit we stop asking that endpoint for usage, and every later turn there
 * is billed as zero. A miss only costs one degraded turn.
 */
export function isStreamUsageRejectedError(raw: unknown): boolean {
  const detail = errorText(raw);
  return (
    /\b(stream_options|include_usage)\b/i.test(detail) &&
    /\b(unsupported|not supported|not allowed|not permitted|invalid|unexpected|unrecognized|unknown|forbidden)\b/i.test(
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
 * The model's real context window, read out of an overflow rejection. No provider
 * puts it in a structured field — it exists only in the prose — but most name it:
 * Anthropic "213456 tokens > 200000 maximum", OpenAI/OpenRouter/vLLM "maximum
 * context length is 128000 tokens", Google "maximum number of tokens allowed
 * (1048576)", Mistral "model with 32768 maximum context length". Each pattern
 * anchors on the LIMIT's own wording so the requested size ("resulted in 130250
 * tokens") is never mistaken for it. Gated on the overflow category first: a rate
 * limit also quotes a token figure, and learning a window from it would be wrong.
 * Null when the text carries no usable number (Bedrock, OpenAI Responses) — the
 * caller then keeps whatever it assumed.
 */
const CONTEXT_WINDOW_SHAPES: RegExp[] = [
  /\d[\d,]*\s*tokens?\s*>\s*(\d[\d,]*)\s*max/i,
  /maximum context length (?:is|of) (\d[\d,]*)/i,
  /context (?:length|window) (?:of|is) (\d[\d,]*)/i,
  /(\d[\d,]*) maximum context/i,
  /maximum(?: number)? of tokens allowed \((\d[\d,]*)\)/i,
];
export function parseContextWindow(raw: unknown): number | null {
  if (!isContextOverflowError(raw)) return null;
  const detail = errorText(raw);
  for (const shape of CONTEXT_WINDOW_SHAPES) {
    const m = shape.exec(detail);
    if (!m) continue;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    // Below 1k is not a window anyone serves; above 50M is a parse gone wrong.
    return n >= 1_000 && n <= 50_000_000 ? n : null;
  }
  return null;
}

/**
 * The gateway mangled the tool call itself — e.g. it merged the argument deltas
 * of two PARALLEL calls into one buffer, so the JSON never parses. Deterministic
 * by nature: the same request rebuilds the same broken string, and each retry
 * pays for the whole prompt again. Never transient.
 */
const CORRUPT_TOOL_CALL =
  /invalid arguments for (function|tool)|(could not|failed to|unable to) parse[^.]{0,24}(tool|function)/i;

/**
 * The HTTP status carried by the error OBJECT (AI SDK's `APICallError.statusCode`;
 * some gateways nest it as `status`). Authoritative in a way the message text is
 * NOT — see isTransientError.
 */
function httpStatus(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { statusCode, status } = raw as Record<string, unknown>;
  const n = typeof statusCode === "number" ? statusCode : typeof status === "number" ? status : undefined;
  return n !== undefined && n >= 100 && n < 600 ? n : undefined;
}

/**
 * Does this HTTP status earn a re-stream?
 *
 * Scoped to exactly what was retried before this function existed — 5xx and rate
 * limits — because the change that introduced it was about not TRUSTING digits
 * found in message text, and narrowing what gets retried is a separate decision
 * with its own cost. Every "yes" here is a full prompt replay plus ~1s of backoff,
 * up to MAX_RECOVERIES times.
 *
 * 429 is here, not because retrying a rate limit after a flat 1s is ideal — it
 * can deepen the limit rather than clear it — but because it is what the previous
 * behaviour did via `rate_limited`, and this check runs BEFORE that branch: left
 * out, it would silently stop retrying the single most common transient failure a
 * provider produces. Pairing it with Retry-After is the improvement worth making,
 * and it belongs to the backoff, not here.
 *
 * The rest stay out deliberately: 408/425 usually repeat under the load that
 * caused them, 409/423 are contention that a blind replay does not resolve, and a
 * gateway reporting its own failure as 400 cannot be told apart from a genuinely
 * malformed request.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * A provider hiccup worth re-streaming (continuation), vs. a fatal config/auth
 * error re-streaming can't fix.
 *
 * Order is the whole point. Everything below the status check reads TEXT, and the
 * text of a provider error includes the request payload — a turn that wrote an
 * HTML file shipped `wght@400;500;600;700` inside the message, which the 5xx regex
 * read as a server error and re-streamed three times. So: the structured status
 * wins when it exists, and the regex survives only as the fallback for providers
 * that answer 200 and put the failure in a stream event.
 */
export function isTransientError(raw: unknown): boolean {
  const detail = errorText(raw);
  if (CORRUPT_TOOL_CALL.test(detail)) return false;

  const status = httpStatus(raw);
  if (status !== undefined) return isTransientStatus(status);

  const { category } = classifyLLMError(raw);
  if (category === "network" || category === "rate_limited") return true;
  // A bare three-digit number is NOT evidence — the detail carries the payload,
  // where 500..529 shows up as a font weight, a price, or a gram count. The digits
  // count only next to something that makes them a status; the named conditions
  // stand on their own.
  return /\b(?:status(?:\s*code)?|code|http|error)\W{0,4}(?:50\d|51\d|52\d)\b|\b(?:50\d|51\d|52\d)\s+(?:internal|bad gateway|service unavailable|server error)|\b(?:internal server error|bad gateway|service unavailable|temporarily unavailable|server error)\b/i.test(
    detail,
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
 * The same deadline, hit by a turn that had already written files or streamed an
 * answer. This is the COMMON case for the run-time ceiling, not the exotic one: the
 * clock runs out on heavy sandbox work precisely because the work was happening.
 * Advising "try again" there means regenerate — re-run every tool and rewrite what
 * is already on screen — so the advice inverts exactly as it does for a stall.
 */
export const TIMED_OUT_PARTIAL_ERROR: FriendlyError = {
  category: "timed_out_partial",
  userMessage:
    "This task ran out of time and stopped part-way. What it finished above is kept — ask it to continue.",
  adminDetail: "Task exceeded the maximum run time and was aborted by the server.",
};

/** Pick which of the two timeout messages a run earns, from what it left behind. */
export function timedOutError(
  parts: ReadonlyArray<{ type: string; text?: string }>,
  /** Executed tool calls the run has on record even when `parts` was cleared. */
  executedWork = false,
): FriendlyError {
  return producedWork(parts, executedWork) ? TIMED_OUT_PARTIAL_ERROR : TIMED_OUT_ERROR;
}

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
 * The same stall, but the turn had already produced work the user can keep —
 * answer text on screen, or a tool step that finished (files in the workspace).
 * Same cause, so the same adminDetail; a different sentence because the advice
 * inverts. "Try again" means REGENERATE, which re-runs every tool from scratch
 * and rewrites what the turn already wrote — the wrong move here. Continuing is
 * the right one, and the reply is resumable precisely because the completed
 * steps replay as history rather than re-executing (see tasks/resume.ts).
 */
export const PROVIDER_UNRESPONSIVE_PARTIAL_ERROR: FriendlyError = {
  category: "provider_unresponsive_partial",
  userMessage:
    "The reply was cut off part-way — the model went quiet. What it finished above is kept; ask it to continue.",
  adminDetail: "Provider streamed no output before the stall timeout; retries were exhausted.",
};

/**
 * Did this turn leave the user anything worth keeping? Reasoning does NOT count,
 * and neither does a tool call with no result: both are visible in the transcript,
 * but neither leaves the user anything to keep, and promising otherwise sends them
 * hunting for files that were never written. Structural parameter type — the caller
 * passes the runner's live parts (`StoredPart[]`), which this module has no reason
 * to depend on.
 *
 * This is the one question behind all three partial/total splits below. Every way
 * a turn can die part-way faces it, and answering it differently per failure is how
 * the timeout path ended up telling a user who had files on screen to start over.
 *
 * A tool that THREW counts too. It ran: the runner's own tool-error branch notes
 * that a script can write three files and then fail on the fourth, and ledgers that
 * call as the one a restarted turn most needs to verify. Reading the same parts and
 * calling it "nothing happened" would put this predicate at odds with
 * `effectsFromParts`, which treats the identical part as an executed effect.
 *
 * KNOWN IMPRECISION: the SDK also synthesizes a `tool-error` for a call it rejected
 * BEFORE running (unparseable arguments, unknown tool), and a row cannot tell the
 * two apart. Counting it errs toward "continue" over "start over", which is the
 * cheaper mistake — but the real fix is upstream, where such a call should not enter
 * `parts` as a tool-error at all; that repairs this predicate and its SQL twin in
 * queue.ts together, which is why neither compensates for it here.
 *
 * `executedWork` is the second source, and it exists because `parts` is not durable:
 * `discardPartial` empties it when an attempt is thrown away, while deliberately
 * KEEPING the executed-call ledger — those calls happened and stay happened. A
 * failure right after such a restart therefore reads no parts at all, and the ledger
 * is the only thing left that knows the workspace was written.
 */
function producedWork(
  parts: ReadonlyArray<{ type: string; text?: string; invalid?: boolean }>,
  executedWork = false,
): boolean {
  return executedWork || parts.some(
    // A `tool-error` the SDK synthesized for a call it REJECTED before running is
    // not work: telling the user "what it finished above is kept" when nothing ran
    // sends them to continue a turn that produced nothing. Excluded here and in the
    // SQL twin together, since the two must agree on one definition.
    (p) => (p.type === "text" && !!p.text?.trim()) || p.type === "tool-result" || (p.type === "tool-error" && !p.invalid),
  );
}

/** Pick which of the two stall messages a finished turn earns, from what it left behind. */
export function providerUnresponsiveError(
  parts: ReadonlyArray<{ type: string; text?: string }>,
  /** Executed tool calls the run has on record even when `parts` was cleared. */
  executedWork = false,
): FriendlyError {
  return producedWork(parts, executedWork) ? PROVIDER_UNRESPONSIVE_PARTIAL_ERROR : PROVIDER_UNRESPONSIVE_ERROR;
}

/**
 * The model stopped because it hit its own output-length limit, not because it
 * had finished — the provider's `finishReason` says "length". The reply on screen
 * is whatever fitted, and it can stop mid-sentence or mid-code.
 *
 * Reported rather than swallowed because a truncated turn is otherwise
 * indistinguishable from a finished one: the user reads an answer that just stops,
 * and — when the cut lands inside a tool call's arguments — watches the sandbox run
 * a program missing its last line, with only the interpreter's syntax error to show
 * for it. Same shape as the partial-stall message above: the work stands, and the
 * move is to continue rather than regenerate.
 *
 * The adminDetail names the lever, because this one is almost always configuration:
 * a gateway or local server with a small default `max_tokens`.
 */
export const RESPONSE_TRUNCATED_ERROR: FriendlyError = {
  category: "response_truncated",
  userMessage:
    "The reply reached the model's length limit and stops part-way. What's above is kept — ask it to continue.",
  adminDetail:
    "Provider finished with reason \"length\": the model reached its maximum output tokens. Raise the model's output limit (or the gateway's default max_tokens) if replies keep being cut off.",
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

/**
 * The same interruption, over work that survived it. A restart mid-turn is exactly
 * when the per-step snapshot earns its keep: the finished steps are on screen and in
 * the workspace, and continuing replays them as history instead of re-executing.
 */
export const INTERRUPTED_PARTIAL_ERROR: FriendlyError = {
  category: "interrupted_partial",
  userMessage:
    "This task was interrupted part-way. What it finished above is kept — ask it to continue.",
  adminDetail: "Worker lost its task lease (server restart or zombie reconciliation); the turn was aborted mid-run.",
};

/** Pick which of the two interruption messages a run earns, from what it left behind. */
export function interruptedError(
  parts: ReadonlyArray<{ type: string; text?: string }>,
  /** Executed tool calls the run has on record even when `parts` was cleared. */
  executedWork = false,
): FriendlyError {
  return producedWork(parts, executedWork) ? INTERRUPTED_PARTIAL_ERROR : INTERRUPTED_ERROR;
}
