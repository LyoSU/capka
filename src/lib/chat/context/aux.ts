import type { ModelMessage } from "ai";

/**
 * Assemble an auxiliary request (memory extraction, etc.) that RIDES the just-
 * finished turn's hot prefix instead of building a fresh, truncated prompt.
 *
 * The same cache-critical shape as compaction (Boris Cherny / "Don't Break the
 * Cache"): keep the warmed system+history prefix byte-for-byte, append the new
 * assistant reply, then the task instruction as the final user turn. The aux
 * call then pays ~cache-read for the whole conversation + the reply + the
 * instruction — and, crucially, SEES the full conversation, so on a long chat it
 * extracts from real context rather than a 2-3k-char slice. The instruction must
 * NOT go in `system` (that would change the prefix and miss the cache).
 */
export function buildAuxRequest(
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
  assistantText: string,
  instruction: string,
): ModelMessage[] {
  const reply: ModelMessage[] = assistantText.trim()
    ? [{ role: "assistant", content: assistantText }]
    : [];
  return [...systemMessages, ...modelMessages, ...reply, { role: "user", content: instruction }];
}
