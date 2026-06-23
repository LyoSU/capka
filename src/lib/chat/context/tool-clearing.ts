import type { StoredPart } from "@/lib/chat/contracts";

/**
 * Placeholder swapped in for a stale tool result's body. The matching `tool-call`
 * (its arguments) is left intact, so the model still knows the call happened and
 * with what — it just no longer re-reads a result it already acted on.
 */
export const CLEARED_TOOL_OUTPUT =
  "[Older tool result cleared to save context. The call's arguments remain visible above.]";

/**
 * Drop the bodies of tool results buried deep in the history, keeping only the
 * `keepLast` most recent ones intact. Counting is GLOBAL across the whole
 * conversation (the agent's last K steps may be spread over several assistant
 * messages), not per-message.
 *
 * Anthropic's cheapest context optimization: once a tool has run deep in the
 * history, the agent rarely needs its raw output again — but that output (a big
 * file read, a loaded skill) is otherwise replayed to the model on every turn.
 * Only the heavy `tool-result.output` is cleared; `tool-call` and `tool-error`
 * (small and high-signal) are untouched. Pure and non-mutating — the DB keeps
 * the full output; only what we feed the model is trimmed.
 */
export function clearStaleToolResults<T extends { parts?: StoredPart[] }>(
  messages: T[],
  keepLast: number,
): T[] {
  // Index (message, part) of every tool-result, in conversation order.
  const positions: { mi: number; pi: number }[] = [];
  messages.forEach((m, mi) => {
    m.parts?.forEach((p, pi) => {
      if (p.type === "tool-result") positions.push({ mi, pi });
    });
  });

  if (positions.length <= keepLast) return messages;

  // Everything except the trailing `keepLast` results gets cleared.
  const stale = new Set(
    positions.slice(0, positions.length - keepLast).map(({ mi, pi }) => `${mi}:${pi}`),
  );

  return messages.map((m, mi) => {
    if (!m.parts) return m;
    let touched = false;
    const parts = m.parts.map((p, pi) => {
      if (p.type === "tool-result" && stale.has(`${mi}:${pi}`)) {
        touched = true;
        return { ...p, output: CLEARED_TOOL_OUTPUT };
      }
      return p;
    });
    return touched ? { ...m, parts } : m;
  });
}
