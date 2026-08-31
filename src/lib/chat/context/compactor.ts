import { generateText, type ModelMessage, type LanguageModel } from "ai";
import { toTokenUsage, type TokenUsage } from "@/lib/pricing";
import { AUX_TIMEOUT_MS } from "./aux";
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
 * the main turn just used (so the prompt cache hits), with the compaction
 * instruction appended as the trailing user message.
 */
export function buildCompactionMessages(
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
): ModelMessage[] {
  return [...systemMessages, ...modelMessages, { role: "user", content: COMPACTION_INSTRUCTION }];
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
 */
export async function compactConversation(
  model: LanguageModel,
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
  sourceTrust: boolean,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ text: string; trust: boolean } | null> {
  try {
    // Own root trace, like the other aux calls — compaction is fire-and-forget and
    // can outlive the turn that triggered it (see auxGenerate).
    const { text, usage } = await withoutParentContext(() => generateText({
      model,
      messages: buildCompactionMessages(systemMessages, modelMessages),
      // Same deadline as the other fire-and-forget aux calls: a hung provider
      // request here pins the whole conversation prefix (see AUX_TIMEOUT_MS).
      abortSignal: AbortSignal.timeout(AUX_TIMEOUT_MS),
      experimental_telemetry: telemetryFor("capka.aux.compaction"),
    }));
    const billable = toTokenUsage(usage);
    if (billable && onUsage) onUsage(billable);
    const summary = text.trim();
    return summary.length > 0 ? { text: summary, trust: sourceTrust } : null;
  } catch (e) {
    log.error("compaction failed", { err: String(e) });
    return null;
  }
}
