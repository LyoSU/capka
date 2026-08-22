import type { StoredPart } from "@/lib/chat/contracts";

/**
 * Placeholder swapped in for a stale tool result's body. The matching `tool-call`
 * keeps its name and id, so the model still knows the call happened — it just no
 * longer re-reads a result it already acted on, or the arguments it already sent.
 */
export const CLEARED_TOOL_OUTPUT =
  "[Older tool result cleared to save context. The call is listed above by name.]";

/**
 * Placeholder swapped in for a stale tool CALL's arguments — the other half of the
 * same eviction, and on a write-heavy turn the half that actually weighs something.
 * A hundred `upsert_product` calls carry a hundred full rows in their arguments and
 * get back an id apiece: clearing only outputs sheds the receipts and keeps the
 * freight. Mirrors `clearToolInputs` on Anthropic's server-side edit, so the policy
 * reads the same on every provider.
 */
export const CLEARED_TOOL_INPUT =
  "[Older tool call's arguments cleared to save context.]";

/**
 * Drop the bodies of tool exchanges buried deep in the history, keeping only the
 * `keepLast` most recent ones intact. Counting is GLOBAL across the whole
 * conversation (the agent's last K steps may be spread over several assistant
 * messages), not per-message.
 *
 * Anthropic's cheapest context optimization: once a tool has run deep in the
 * history, the agent rarely needs its raw output — or the arguments it sent —
 * again, but both are otherwise replayed to the model on every turn. A cleared
 * exchange loses its `tool-result.output` AND the matching `tool-call.input`;
 * the call's `name` and `id` stay, so the timeline still reads. `tool-error` is
 * never touched (small and high-signal). Pure and non-mutating — the DB keeps
 * everything; only what we feed the model is trimmed.
 *
 * Clearing inputs has a real cost, and this is the deliberate trade: for a call
 * whose arguments ARE the payload (a row being written) the input is the whole
 * point of clearing, but for one whose arguments merely name the result (a file
 * path, a search term) the model loses the record of what it already looked at,
 * and an agent that can't see that re-does it. The bound on the damage is
 * `keepLast`: the freshest exchanges keep everything, so what's lost is only the
 * detail of work the agent has long since acted on. If re-reading ever shows up
 * in traces, the lever is a per-tool exemption here — NOT reverting to
 * results-only, which is what let a bulk-write turn ride to the context ceiling
 * with clearing switched on the whole time.
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
  const staleCut = positions.slice(0, positions.length - keepLast);
  const stale = new Set(staleCut.map(({ mi, pi }) => `${mi}:${pi}`));
  // The call that produced each stale result, matched by tool-call id — its
  // arguments go with it. Ids, not positions: a call and its result routinely sit
  // in different messages (and a suspended/approved call in a different turn).
  const staleCallIds = new Set(staleCut.map(({ mi, pi }) => messages[mi].parts![pi]).map((p) => (p as { id: string }).id));

  return messages.map((m, mi) => {
    if (!m.parts) return m;
    let touched = false;
    const parts = m.parts.map((p, pi) => {
      if (p.type === "tool-result" && stale.has(`${mi}:${pi}`)) {
        touched = true;
        return { ...p, output: CLEARED_TOOL_OUTPUT };
      }
      if (p.type === "tool-call" && staleCallIds.has(p.id)) {
        touched = true;
        return { ...p, input: CLEARED_TOOL_INPUT };
      }
      return p;
    });
    return touched ? { ...m, parts } : m;
  });
}
