interface FillMeta {
  usage?: { input: number; cached: number };
  contextWindow?: number;
  compaction?: unknown;
}

/**
 * Context-window fill for the composer meter, derived from message metadata.
 *
 * Two rules:
 *  - If the newest message IS a compaction checkpoint, return null: compaction
 *    just ran, so the last reply's usage (which is what tripped it, ~100%) no
 *    longer reflects the now-collapsed context. The real size isn't known until
 *    the next turn, so the meter hides rather than lie at 100%.
 *  - Otherwise use the most recent reply that reported usage + window.
 */
export function deriveContextFill(
  messages: { metadata?: unknown }[],
): { used: number; window: number } | null {
  const last = messages[messages.length - 1]?.metadata as FillMeta | undefined;
  if (last?.compaction) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i].metadata as FillMeta | undefined;
    if (m?.usage && m.contextWindow) {
      return { used: m.usage.input + m.usage.cached, window: m.contextWindow };
    }
  }
  return null;
}
