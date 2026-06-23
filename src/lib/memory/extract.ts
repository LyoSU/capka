import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { log } from "@/lib/log";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";
import { buildAuxRequest } from "@/lib/chat/context/aux";

/** Appended-mode instruction (user turn). Same intent as EXTRACTION_PROMPT, but
 *  it points at the conversation ALREADY in context rather than a pasted slice —
 *  used on long chats where riding the hot prefix beats a fresh truncated call. */
const EXTRACTION_INSTRUCTION =
  "Based on our conversation above, extract any new facts, preferences, or work context about ME (the user) worth remembering. " +
  "One fact per line, no bullets, each under 20 words. Only facts about me, grounded in what I said — not general knowledge, not facts about your replies. " +
  "If there are no new facts, output nothing.";

const EXTRACTION_PROMPT = `You extract key facts about the user from a conversation turn. The user's own message is the primary signal; the assistant's reply is context only. Identify any new facts, preferences, or context about the USER that would be useful to remember for future conversations.

Rules:
- Output one fact per line, no bullets or numbering
- Keep each fact concise (under 20 words)
- Only extract facts about the USER, not general knowledge, and not facts about the assistant's reply
- Base facts on what the user states or implies — do not invent facts the assistant merely mentioned
- Categories: facts about the user, their preferences, or their work context
- If there are no new facts to extract, output nothing

Examples of good extractions:
Uses TypeScript and prefers minimal code
Works in the finance team at a mid-size company
Prefers dark mode
Building a project management tool with Next.js`;

/** One conversation turn to mine for facts. The user message is the high-signal
 *  source; the assistant reply is optional context for disambiguation. */
export interface ConversationTurn {
  userText: string;
  assistantText?: string;
}

/**
 * Extract memorable facts about the user from a conversation turn.
 * Deduplicates against existing memories using simple string similarity.
 */
export async function extractMemories(
  model: LanguageModel,
  turn: ConversationTurn,
  existingMemories: string[],
  /** Called with the spend of this (otherwise unbilled) auxiliary LLM call, so
   *  the runner can record it against the same key/budget as the main turn. */
  onUsage?: (usage: TokenUsage) => void,
  /** Long-chat path: the just-finished turn's hot system+history prefix. When
   *  given, extraction rides that prefix (full context, cache-read priced)
   *  instead of a fresh truncated call. Omit on short chats — a small standalone
   *  call is cheaper there (hybrid by length). */
  hotContext?: { systemMessages: ModelMessage[]; modelMessages: ModelMessage[] },
): Promise<string[]> {
  const userText = (turn.userText ?? "").trim();
  if (userText.length < 20) return [];

  const prompt =
    `User message:\n${userText.slice(0, 2000)}` +
    (turn.assistantText?.trim()
      ? `\n\nAssistant reply (context only):\n${turn.assistantText.trim().slice(0, 1000)}`
      : "");

  try {
    const { text: extracted, usage } = hotContext
      ? await generateText({
          model,
          // Cache-friendly: ride the warm prefix, instruction as the trailing
          // user turn (no `system` override, which would miss the cache).
          messages: buildAuxRequest(
            hotContext.systemMessages,
            hotContext.modelMessages,
            turn.assistantText ?? "",
            EXTRACTION_INSTRUCTION,
          ),
          maxOutputTokens: 200,
        })
      : await generateText({
          model,
          system: EXTRACTION_PROMPT,
          prompt,
          maxOutputTokens: 200,
        });

    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);

    if (!extracted.trim()) return [];

    const candidates = extracted
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 5 && l.length < 200)
      .slice(0, 10);

    // Deduplicate against existing memories
    const existingLower = existingMemories.map((m) => m.toLowerCase());
    return candidates.filter((candidate) => {
      const lower = candidate.toLowerCase();
      return !existingLower.some(
        (existing) =>
          existing.includes(lower) ||
          lower.includes(existing) ||
          similarity(existing, lower) > 0.7,
      );
    });
  } catch (e) {
    log.error("memory extraction failed", { err: String(e) });
    return [];
  }
}

/** Simple word-overlap similarity (Jaccard index). */
function similarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
