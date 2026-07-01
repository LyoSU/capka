import type { ModelMessage } from "ai";

/**
 * After this many tool steps WITHIN a single turn, force the model to answer in
 * text. Below the hard `stepCountIs(25)` cap, so a long tool loop produces a real
 * reply instead of being cut off mid-tool at the ceiling.
 */
export const FORCE_TEXT_AFTER_STEPS = 20;

/**
 * Drop `reasoning` parts from assistant messages (returns a fresh array; inputs
 * without reasoning pass through). Used REACTIVELY after a backend rejects the
 * model's own echoed `reasoning_content` (isReasoningEchoRejectedError). With
 * tools the offending echo is an INTERMEDIATE assistant message that streamText
 * generates inside its own tool loop and re-feeds on the next step — it never
 * appears in the input `modelMessages`, so it can only be caught per-step in
 * prepareStep. The tool-call part is kept so the following tool result isn't
 * orphaned.
 */
export function stripReasoningFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) =>
    m.role === "assistant" && Array.isArray(m.content)
      ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
      : m,
  );
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
