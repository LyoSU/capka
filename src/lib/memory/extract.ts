import { generateText } from "ai";
import type { LanguageModel } from "ai";

const EXTRACTION_PROMPT = `You extract key facts about the user from a conversation. Given the assistant's response, identify any new facts, preferences, or context about the user that would be useful to remember for future conversations.

Rules:
- Output one fact per line, no bullets or numbering
- Keep each fact concise (under 20 words)
- Only extract facts about the USER, not general knowledge
- Categories: facts about the user, their preferences, or their work context
- If there are no new facts to extract, output nothing

Examples of good extractions:
Uses TypeScript and prefers minimal code
Works at a company called KNESS Group
Prefers dark mode
Building a project management tool with Next.js`;

/**
 * Extract memorable facts from conversation text.
 * Deduplicates against existing memories using simple string similarity.
 */
export async function extractMemories(
  model: LanguageModel,
  text: string,
  existingMemories: string[],
): Promise<string[]> {
  if (!text || text.length < 20) return [];

  try {
    const { text: extracted } = await generateText({
      model,
      system: EXTRACTION_PROMPT,
      prompt: `Assistant response:\n${text.slice(0, 2000)}`,
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
    console.error("[memory] extraction failed:", e);
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
