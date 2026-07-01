import type { ModelMessage } from "ai";

/**
 * After this many tool steps WITHIN a single turn, force the model to answer in
 * text. Below the hard `stepCountIs(25)` cap, so a long tool loop produces a real
 * reply instead of being cut off mid-tool at the ceiling.
 */
export const FORCE_TEXT_AFTER_STEPS = 20;

/**
 * Fold `reasoning` parts of assistant messages INTO their text (returns a fresh
 * array; inputs without reasoning pass through). Used REACTIVELY after a backend
 * rejects the model's own echoed `reasoning_content`
 * (isReasoningEchoRejectedError).
 *
 * Why fold, not drop: `@ai-sdk/openai-compatible` serializes a `reasoning` part
 * as the `reasoning_content` field, which Cerebras 400s on input. But Cerebras'
 * gpt-oss is a reasoning model that needs its prior thinking to continue a
 * tool-calling turn — DROPPING it entirely just trades the 400 for a silent
 * hang. Cerebras' own docs say to retain reasoning by prepending it into
 * `content` instead (GPT-OSS: reasoning directly before the answer). Folding it
 * to a text part does exactly that: no `reasoning_content` field (no 400) and
 * the thinking survives in content (no stall). The tool-call part is kept so a
 * following tool result isn't orphaned.
 *
 * With tools the offending echo is an INTERMEDIATE assistant message that
 * streamText generates inside its own tool loop and re-feeds on the next step —
 * it never appears in the input `modelMessages`, so it can only be reached
 * per-step in prepareStep.
 */
export function foldReasoningIntoText(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const reasoning = m.content
      .filter((p): p is Extract<typeof p, { type: "reasoning" }> => p.type === "reasoning")
      .map((p) => p.text)
      .join("");
    if (!reasoning) return m;
    const rest = m.content.filter((p) => p.type !== "reasoning");
    const i = rest.findIndex((p) => p.type === "text");
    if (i >= 0) {
      // Immutable: don't mutate the part object AI SDK handed us in prepareStep.
      const merged = rest.map((p, j) =>
        j === i ? { ...p, text: `${reasoning}\n\n${(p as { text: string }).text}` } : p,
      );
      return { ...m, content: merged };
    }
    return { ...m, content: [{ type: "text", text: reasoning }, ...rest] };
  });
}

/**
 * Per-step settings for streamText's prepareStep hook.
 *
 * CACHE NOTE: this deliberately NEVER returns `messages`. Rewriting the message
 * array between steps would change the prompt prefix on every step and break the
 * prompt cache mid-turn (the exact trap from "Don't Break the Cache"). Switching
 * `toolChoice` does invalidate the cache once — but only on this single late
 * step, where the turn is wrapping up anyway, so the cost is one-off, not
 * per-step. Hence the only lever here is a late `toolChoice: 'none'`.
 */
export function stepSettings(stepNumber: number): { toolChoice?: "none" } {
  return stepNumber >= FORCE_TEXT_AFTER_STEPS ? { toolChoice: "none" } : {};
}
