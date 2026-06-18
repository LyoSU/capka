import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { log } from "@/lib/log";

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
Works at a company called KNESS Group
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
): Promise<string[]> {
  const userText = (turn.userText ?? "").trim();
  if (userText.length < 20) return [];

  const prompt =
    `User message:\n${userText.slice(0, 2000)}` +
    (turn.assistantText?.trim()
      ? `\n\nAssistant reply (context only):\n${turn.assistantText.trim().slice(0, 1000)}`
      : "");

  try {
    const { text: extracted } = await generateText({
      model,
      system: EXTRACTION_PROMPT,
      prompt,
      maxOutputTokens: 200,
    });

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
