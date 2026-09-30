import { convertToModelMessages, generateText, type ModelMessage, type LanguageModel } from "ai";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";
import type { ConsumedSteer, StoredPart } from "@/lib/chat/contracts";
import { toUIMessages, expandSteers } from "@/lib/chat/presenter";
import { sealOrphanToolCalls } from "@/lib/chat/tool-results";
import { AUX_TIMEOUT_MS } from "./aux";
import { buildModelContext } from "./build";
import { TOOL_CLEAR_KEEP_LAST } from "./provider-edits";
import { foldReasoningIntoText } from "./step-control";
import { isReasoningEchoRejectedError } from "@/lib/errors/friendly";
import { log } from "@/lib/log";
import { telemetryFor, withoutParentContext } from "@/lib/telemetry";

/**
 * The compaction instruction, delivered as the FINAL user turn rather than as a
 * replacement system prompt. This is the cache-critical detail (per Boris
 * Cherny / "Don't Break the Cache"): editing the system prompt invalidates the
 * whole cached prefix, but appending one user turn keeps the just-warmed
 * system+history prefix a cache hit — so compaction costs ~cache-read + this
 * short instruction + the summary, not a full re-read of the conversation.
 *
 * Tuned per Anthropic's guidance: maximize recall first (never drop goals,
 * decisions, open bugs, established facts), then precision (drop raw tool
 * outputs already acted on, logs, pleasantries).
 */
export const COMPACTION_INSTRUCTION = [
  "Before we continue, compact our conversation so far into a high-fidelity summary",
  "that lets you carry on with no loss of important context.",
  "",
  "PRESERVE (never drop): my goals and constraints, decisions we made, unresolved",
  "problems and open bugs, key facts, file paths and names, and important results",
  "you produced.",
  "",
  "DISCARD: raw tool outputs you already acted on, verbose logs, redundant",
  "restatements, pleasantries, and resolved tangents.",
  "",
  "Write concise plain prose organized by topic. Output ONLY the summary.",
].join("\n");

/**
 * Assemble the request for a compaction turn: the SAME system + history prefix
 * the main turn just used (so the prompt cache hits), followed by the reply that
 * turn wrote (compactionReply, appended to `modelMessages` by the caller), with
 * the compaction instruction appended as the trailing user message.
 */
export function buildCompactionMessages(
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
): ModelMessage[] {
  return [...systemMessages, ...modelMessages, { role: "user", content: COMPACTION_INSTRUCTION }];
}

/**
 * The reply that tripped compaction, as model messages, shaped the way the NEXT
 * turn's history would carry it — the checkpoint hangs below this reply, so the
 * summary is all of it any later turn will see. The steers it folded in come first
 * (expandSteers), reasoning is kept (folded into text where this turn learned the
 * backend rejects its echo), and stale tool bodies are cleared to the shared
 * keep-last policy.
 *
 * The clearing is what keeps the request inside the window. The live turn shed its
 * older tool traffic mid-loop (or Anthropic did, server-side) and compaction fires on
 * the size of THAT pruned prompt; rebuilt from `parts` in full, a file-reading loop
 * puts back everything it shed and the summary request overflows. Compaction fires
 * past the clearing trigger by construction (75% of the window against at most 50%),
 * so this is also exactly what the next turn would have cleared.
 *
 * Not the resume pipeline: that drops reasoning and steers for a re-stream.
 */
export async function compactionReply(
  id: string,
  parts: StoredPart[],
  steers: ConsumedSteer[],
  reasoningStripped: boolean,
): Promise<ModelMessage[]> {
  const rows = buildModelContext(
    [{ id, role: "assistant", content: "", createdAt: null, platform: null, metadata: { parts, ...(steers.length ? { steers } : {}) } }],
    { clearToolsKeepLast: TOOL_CLEAR_KEEP_LAST },
  );
  // No `status` on the row, so toUIMessages seals a call left without a result.
  // Laundered at the SDK boundary exactly as buildResumeMessages does.
  const msgs = await convertToModelMessages(sealOrphanToolCalls(toUIMessages(expandSteers(rows))) as never);
  return reasoningStripped ? foldReasoningIntoText(msgs) : msgs;
}

/**
 * Run the compaction turn on the hot prefix and return the summary text (or null
 * if the model abstained / it failed — the caller then writes no checkpoint and
 * leaves the conversation as-is). Thin I/O wrapper, mirroring generateChatTitle:
 * the cache-critical assembly is buildCompactionMessages above.
 *
 * `sourceTrust` is carried through rather than computed: a summary is only ever as
 * trustworthy as the prompt it summarized, so a checkpoint written from a tainted
 * conversation must be tainted too — otherwise compaction launders a poisoned
 * paragraph into a clean-looking recap and a compacted prompt ends up CLEANER than
 * the prompt it replaced. It sits FOURTH, before the optional `onUsage`: a required
 * parameter after an optional one is a call-site trap.
 *
 * `providerOptions` carries the provider's server-side context edit, so the request
 * is shed the way the live turn's prompt was (see the runner).
 *
 * A backend that rejects echoed `reasoning_content` gets one retry with reasoning
 * folded into text. The turn only learns that when IT echoed, and a single-step
 * reply over a history with no reasoning never does — but this request echoes the
 * reply's own reasoning.
 */
export async function compactConversation(
  model: LanguageModel,
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
  sourceTrust: boolean,
  onUsage?: (usage: TokenUsage) => void,
  providerOptions?: Record<string, unknown>,
): Promise<{ text: string; trust: boolean } | null> {
  // Own root trace, like the other aux calls — compaction is fire-and-forget and
  // can outlive the turn that triggered it (see auxGenerate).
  const run = (msgs: ModelMessage[]) => withoutParentContext(() => generateText({
    model,
    messages: buildCompactionMessages(systemMessages, msgs),
    providerOptions: providerOptions as never,
    // Same deadline as the other fire-and-forget aux calls: a hung provider
    // request here pins the whole conversation prefix (see AUX_TIMEOUT_MS).
    abortSignal: AbortSignal.timeout(AUX_TIMEOUT_MS),
    experimental_telemetry: telemetryFor("capka.aux.compaction"),
  }));
  try {
    const { text, usage } = await run(modelMessages).catch((e) => {
      if (!isReasoningEchoRejectedError(e)) throw e;
      return run(foldReasoningIntoText(modelMessages));
    });
    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);
    const summary = text.trim();
    return summary.length > 0 ? { text: summary, trust: sourceTrust } : null;
  } catch (e) {
    log.error("compaction failed", { err: String(e) });
    return null;
  }
}
