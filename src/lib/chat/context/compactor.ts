import { convertToModelMessages, generateText, type ModelMessage, type LanguageModel } from "ai";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";
import type { ConsumedSteer, StoredPart } from "@/lib/chat/contracts";
import { toUIMessages, expandSteers } from "@/lib/chat/presenter";
import { sealOrphanToolCalls } from "@/lib/chat/tool-results";
import { AUX_TIMEOUT_MS } from "./aux";
import { buildModelContext } from "./build";
import { TOOL_CLEAR_KEEP_LAST } from "./provider-edits";
import { foldReasoningIntoText, pruneTurnToolTraffic } from "./step-control";
import { isContextOverflowError, isReasoningEchoRejectedError } from "@/lib/errors/friendly";
import { log } from "@/lib/log";
import { telemetryFor, withoutParentContext } from "@/lib/telemetry";

/**
 * The compaction instruction, delivered as the FINAL user turn rather than as a
 * replacement system prompt (per Boris Cherny / "Don't Break the Cache"): editing
 * the system prompt changes the prefix outright, while appending one user turn
 * leaves the system + history bytes the turn sent. That is the part of a cache hit
 * this request controls, not a promise of one. It sends no tool definitions and runs
 * with thinking off. On Anthropic, where tool definitions lead the cached prefix, a
 * chat with tools therefore misses outright and pays full input price for the
 * summary, and a turn that ran with thinking misses the cached messages. A provider
 * that caches the message prefix alone can hit it.
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
 * Assemble the request for a compaction turn: the system prompt and the history the
 * main turn just used, followed by the reply that turn wrote (see compactionInput),
 * with the compaction instruction appended as the trailing user message.
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
 * What the compaction request summarizes: the history, then the reply.
 *
 * On a provider we prune for, the live turn's mid-loop prune (pruneTurnToolTraffic)
 * cuts across the WHOLE prompt once it arms — the history's tool bodies go with the
 * turn's own — and `shouldCompact` measured that result. `history` was built at turn
 * start, before any of it, so the request is cut too (`prunedMidTurn`) or it replays
 * every body the prune shed and overflows the window it was sized against. This cut
 * clears EVERY history body: at least what the live cut shed, and more when the turn
 * made fewer than three tool exchanges (the live cut then kept the history's newest),
 * so the request can come out smaller than the prompt measured, never larger. When
 * the prune never armed, the list is left alone and the history goes out byte for
 * byte as the turn sent it.
 */
export function compactionInput(history: ModelMessage[], reply: ModelMessage[], prunedMidTurn: boolean): ModelMessage[] {
  const msgs = [...history, ...reply];
  // Cut at the reply, not at the live cut's "last N messages": the rebuilt reply is one
  // assistant row, not a message per step, so counting messages from the end reaches
  // back into the history and keeps the newest bodies the live cut shed. The reply
  // already kept its own newest bodies (compactionReply); the history's are all older.
  return prunedMidTurn ? pruneTurnToolTraffic(msgs, history.length) : msgs;
}

/**
 * Run the compaction turn and return the summary text (or null
 * if the model abstained / it failed — the caller then writes no checkpoint and
 * leaves the conversation as-is). Thin I/O wrapper, mirroring generateChatTitle:
 * the message assembly is buildCompactionMessages above.
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
 *
 * An overflow gets one retry with every tool body cleared and all reasoning dropped.
 * The request can outgrow the prompt `shouldCompact` measured: the final step's own
 * output was never in it, and a provider may count the output budget against the
 * window too. Tool bodies are what the instruction discards anyway, and reasoning is
 * the model's scratch, not the conversation. It never drops a turn: the checkpoint
 * replaces everything before it, so a turn left out of the input is gone for every
 * later one. Still too long, it fails like any other error.
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
    messages: msgs,
    providerOptions: providerOptions as never,
    // Same deadline as the other fire-and-forget aux calls: a hung provider
    // request here pins the whole conversation prefix (see AUX_TIMEOUT_MS).
    abortSignal: AbortSignal.timeout(AUX_TIMEOUT_MS),
    experimental_telemetry: telemetryFor("capka.aux.compaction"),
  }));
  const messages = buildCompactionMessages(systemMessages, modelMessages);
  try {
    const { text, usage } = await run(messages).catch((e) => {
      if (isReasoningEchoRejectedError(e)) return run(foldReasoningIntoText(messages));
      if (!isContextOverflowError(e)) throw e;
      const bare = messages.flatMap((m): ModelMessage[] => {
        if (m.role !== "assistant" || typeof m.content === "string") return [m];
        const content = m.content.filter((p) => p.type !== "reasoning");
        return content.length ? [{ ...m, content }] : [];
      });
      // Cut at the instruction, the last message: every tool body ahead of it goes.
      return run(pruneTurnToolTraffic(bare, bare.length - 1));
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
