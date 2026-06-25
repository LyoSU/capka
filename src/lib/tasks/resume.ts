import { convertToModelMessages, type ModelMessage } from "ai";
import { toUIMessages } from "@/lib/chat/presenter";
import { sealOrphanToolCalls } from "@/lib/chat/tool-results";
import type { StoredPart } from "@/lib/chat/contracts";

// English — instruction for the model, not the user.
const CONTINUE =
  "Your previous response was cut off mid-way. Continue from exactly where it stopped — do not repeat any text you already produced, and do not mention the interruption.";

/**
 * A continuation re-stream is a fresh assistant turn, so the model may re-emit
 * the last few words. Strip the longest prefix of `delta` that is already a
 * suffix of `tail`. Applied once, to the first text delta after a resume.
 */
export function stitchOverlap(tail: string, delta: string): string {
  for (let n = Math.min(tail.length, delta.length); n > 0; n--) {
    if (tail.endsWith(delta.slice(0, n))) return delta.slice(n);
  }
  return delta;
}

/**
 * Rebuild the in-progress reply to RESUME it, ending on a `user` "continue" turn
 * (never an assistant prefill — that 400s on modern Anthropic models). Reuses the
 * history pipeline so tool-result shapes match and a dangling tool-call is sealed
 * into a terminal pair (no unpaired tool_use). Reasoning is dropped — partial
 * thinking isn't replayable, and the caller disables reasoning on the re-stream.
 * Returns [] when there's nothing to resume from (caller restarts clean).
 */
export async function buildResumeMessages(msgId: string, parts: StoredPart[]): Promise<ModelMessage[]> {
  const replayable = parts.filter((p) => p.type !== "reasoning");
  if (replayable.length === 0) return [];
  // status omitted (≠ "running") so toUIMessages seals a dangling call as output-error.
  const ui = sealOrphanToolCalls(
    toUIMessages([
      { id: msgId, role: "assistant", content: "", metadata: { parts: replayable }, createdAt: null, platform: null },
    ]),
  );
  // toUIMessages returns loosely-typed parts (unknown[]); convertToModelMessages
  // wants UIMessage[]. The runner launders the same call through `any` — match it
  // at the SDK boundary rather than re-typing the presenter.
  const assistantMsgs = await convertToModelMessages(ui as never);
  if (assistantMsgs.length === 0) return [];
  return [...assistantMsgs, { role: "user", content: CONTINUE }];
}
