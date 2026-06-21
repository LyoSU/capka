import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { log } from "@/lib/log";

// Tweak point: tone/length of auto-generated chat titles lives here. The model
// detects the conversation language itself — keep the "same language" rule so a
// Ukrainian chat never gets an English title.
const TITLE_PROMPT = `You write a short, descriptive title for a chat from its first exchange.

Rules:
- 3 to 6 words, never a full sentence
- Same language as the user's message
- Capture the topic or task, not a greeting or pleasantry
- No quotes, no markdown, no trailing punctuation, no emoji
- If the message has no clear topic (just a greeting, "hi", "test"), output exactly: -`;

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
): Promise<string | null> {
  const user = (userText ?? "").trim();
  if (user.length < 2) return null;

  const prompt =
    `User message:\n${user.slice(0, 2000)}` +
    (assistantText?.trim()
      ? `\n\nAssistant reply (context only):\n${assistantText.trim().slice(0, 1000)}`
      : "");

  try {
    const { text } = await generateText({
      model,
      system: TITLE_PROMPT,
      prompt,
      maxOutputTokens: 32,
    });
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
