/**
 * Seal tool calls that never received a result, so the model SDK accepts the
 * history.
 *
 * `convertToModelMessages` throws `AI_MissingToolResultsError` when an assistant
 * tool call has no matching tool result. That happens whenever a turn is
 * interrupted mid-tool — the deadline fires, the worker's lease is lost, or the
 * user cancels — after the call was persisted (saveSnapshot writes each call the
 * moment it starts) but before its result arrived. The dangling call then sits
 * in history forever and poisons EVERY later turn that feeds it to the model,
 * not just the one that died. Forking makes it vivid: the fork copies the
 * interrupted turn into a fresh chat, and the new chat is dead on its first
 * send ("the cloned chat died").
 *
 * Each orphan becomes a terminal error result rather than being dropped: the
 * model still sees the call that was made, learns it didn't finish, and the
 * assistant message keeps any surrounding text (dropping a lone tool call would
 * leave an empty assistant message — its own SDK error). Mutates in place and
 * returns the same array.
 *
 * A declined approval gets the same treatment for the same reason (see below).
 *
 * Only ever apply this to HISTORY being fed to the model — never to a live,
 * streaming turn, where an `input-available` tool call legitimately means
 * "running right now" and the UI must keep showing its spinner.
 */
const ORPHAN_STATES = new Set(["input-streaming", "input-available"]);

/** The synthetic result a dangling tool call is sealed with — shared with the
 *  presenter so the model-feed seal and the transcript display agree on wording. */
export const INTERRUPTED_TOOL_RESULT =
  "The previous turn was interrupted before this tool finished, so it has no result.";

export function sealOrphanToolCalls<T extends { role: string; parts?: unknown[] }>(messages: T[]): T[] {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.parts)) continue;
    for (const part of m.parts as Array<Record<string, unknown>>) {
      const type = part.type;
      // toUIMessages emits tool steps as `dynamic-tool`; accept typed `tool-*`
      // parts too so any future producer is covered. An orphan is a tool part
      // still in an input-* state (no output yet).
      const isToolPart =
        type === "dynamic-tool" || (typeof type === "string" && type.startsWith("tool-"));
      if (isToolPart && ORPHAN_STATES.has(part.state as string)) {
        part.state = "output-error";
        if (part.errorText == null) part.errorText = INTERRUPTED_TOOL_RESULT;
      }
      // A declined approval is stored as its decision alone — nothing ever writes
      // it a result, and the web card needs it that way to read "declined". The
      // SDK synthesizes the denial only while that response is the LAST message
      // (the resume); on every later turn it strips the response and leaves a bare
      // call, which providers reject. `output-denied` makes convertToModelMessages
      // emit the denial as a real result on every turn, the resume included (the
      // SDK skips synthesizing one for an approval whose result is already there).
      if (isToolPart && part.state === "approval-responded" && (part.approval as { approved?: boolean } | undefined)?.approved === false) {
        part.state = "output-denied";
      }
    }
  }
  return messages;
}
