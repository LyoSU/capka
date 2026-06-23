import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { log } from "@/lib/log";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";

// Tweak point: tone/length of auto-generated chat titles lives here. The model
// detects the conversation language itself — keep the "same language" rule so a
// Ukrainian chat never gets an English title.
const TITLE_PROMPT = `You write a short, descriptive title for a chat from its first exchange.

Rules:
- 3 to 6 words, never a full sentence
- Same language as the user's message
- Capture the topic or task, not a greeting or pleasantry
- No quotes, no markdown, no trailing punctuation, no emoji
- Almost always write a title. If the message contains ANY question, request,
  task, or subject, title it — even if the message also mentions "test",
  "testing", or "trying out".
- Output exactly "-" ONLY for a message that is pure greeting or empty filler
  with nothing whatsoever to name (e.g. "hi", "hello", "ok", "thanks", "test").`;

const MAX_TITLE_LEN = 80;

/**
 * Generate a concise chat title from the first user/assistant turn. Returns
 * null when there's nothing worth titling (model abstained, empty, or failed)
 * so the caller keeps the existing placeholder instead of a blank title.
 */
export async function generateChatTitle(
  model: LanguageModel,
  userText: string,
  assistantText?: string,
  /** Called with the spend of this (otherwise unbilled) auxiliary LLM call, so
   *  the runner can record it against the same key/budget as the main turn. */
  onUsage?: (usage: TokenUsage) => void,
): Promise<string | null> {
  const user = (userText ?? "").trim();
  if (user.length < 2) return null;

  const prompt =
    `User message:\n${user.slice(0, 2000)}` +
    (assistantText?.trim()
      ? `\n\nAssistant reply (context only):\n${assistantText.trim().slice(0, 1000)}`
      : "");

  try {
    const { text, usage } = await generateText({
      model,
      system: TITLE_PROMPT,
      prompt,
      // Generous budget so reasoning models (DeepSeek-R1 et al.) can finish their
      // <think> block AND still emit the title — a tight cap left them cut off
      // mid-thought with nothing to title. Non-reasoning models stop after the
      // 3–6 words anyway, so this costs ~nothing extra for them.
      maxOutputTokens: 1000,
    });
    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);
    return sanitizeTitle(text);
  } catch (e) {
    log.error("chat title generation failed", { err: String(e) });
    return null;
  }
}

/** Strip the model's framing (quotes, trailing punctuation, the "-" abstain
 *  sentinel) and clamp length. Exported for unit testing. */
export function sanitizeTitle(raw: string): string | null {
  let t = (raw ?? "").trim();
  if (!t) return null;
  // Reasoning models (DeepSeek-R1 et al. via OpenRouter) inline their chain of
  // thought as <think>…</think> in the content. Drop closed blocks, then any
  // dangling unclosed tag — if the budget still ran out mid-thought the
  // remainder is all reasoning and nothing to title.
  t = t.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi, "").trim();
  t = t.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*$/i, "").trim();
  if (!t) return null;
  // Models sometimes wrap titles in quotes (incl. Ukrainian «») or add a
  // leading dash/bullet.
  t = t.replace(/^["'“”‘’`«»‹›]+|["'“”‘’`«»‹›]+$/g, "").trim();
  t = t.replace(/^[-–—•*]\s*/, "").trim();
  // Collapse internal whitespace/newlines to single spaces.
  t = t.replace(/\s+/g, " ");
  // Drop a trailing sentence terminator the model may have appended.
  t = t.replace(/[.!?,;:]+$/, "").trim();
  // The abstain sentinel, or nothing left after stripping.
  if (!t || t === "-") return null;
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim();
  return t || null;
}
