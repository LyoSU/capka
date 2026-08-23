import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { isReasoningUnsupportedError } from "@/lib/errors/friendly";
import { getModelCannotReason, rememberModelCannotReason } from "@/lib/models/catalog";
import { log } from "@/lib/log";
import { telemetryFor, withoutParentContext } from "@/lib/telemetry";

/**
 * Assemble an auxiliary request (memory extraction, etc.) that RIDES the just-
 * finished turn's hot prefix instead of building a fresh, truncated prompt.
 *
 * The same cache-critical shape as compaction (Boris Cherny / "Don't Break the
 * Cache"): keep the warmed system+history prefix byte-for-byte, append the new
 * assistant reply, then the task instruction as the final user turn. The aux
 * call then pays ~cache-read for the whole conversation + the reply + the
 * instruction — and, crucially, SEES the full conversation, so on a long chat it
 * extracts from real context rather than a 2-3k-char slice. The instruction must
 * NOT go in `system` (that would change the prefix and miss the cache).
 */
export function buildAuxRequest(
  systemMessages: ModelMessage[],
  modelMessages: ModelMessage[],
  assistantText: string,
  instruction: string,
): ModelMessage[] {
  const reply: ModelMessage[] = assistantText.trim()
    ? [{ role: "assistant", content: assistantText }]
    : [];
  return [...systemMessages, ...modelMessages, ...reply, { role: "user", content: instruction }];
}

/**
 * Reasoning is pointless for mechanical aux calls (title, memory reconcile,
 * consolidation) and — worse — on an always-thinking model the thinking tokens
 * eat the output budget before any answer lands. So we ask each provider for
 * the least/no reasoning. Mirror image of the runner's reasoningOptions();
 * unknown providers keep their default.
 */
function auxReasoningOptions(provider: string): Record<string, Record<string, unknown>> | undefined {
  switch (provider) {
    case "anthropic": return { anthropic: { thinking: { type: "disabled" } } };
    case "openrouter": return { openrouter: { reasoning: { enabled: false } } };
    case "openai": return { openai: { reasoningEffort: "low" } };
    case "google": return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    case "litellm":
    case "deepseek":
    case "mistral":
    case "xai":
    case "zhipu": return { [provider]: { reasoningEffort: "low" } };
    default: return undefined;
  }
}

type AuxArgs =
  | { messages: ModelMessage[]; maxOutputTokens: number }
  | { system: string; prompt: string; maxOutputTokens: number };

/** Hard deadline per aux LLM call. These are fire-and-forget (trackAux) and
 *  their prompt is the WHOLE conversation prefix — a provider request that
 *  hangs past undici's between-chunks timeouts (a server trickling bytes)
 *  would otherwise pin megabytes of context for as long as it pleases, and
 *  every finished turn spawns new such calls. Aux outputs are short (a title,
 *  a memory doc, a summary), so 3 minutes is generous. */
export const AUX_TIMEOUT_MS = 180_000;

/** generateText for aux calls: suppress reasoning, but if a non-reasoning model
 *  rejects the knob (gpt-4o, claude-3.5…), retry once without it — same
 *  optimistic-then-fallback philosophy as the main run. */
export async function auxGenerate(model: LanguageModel, provider: string, args: AuxArgs, label = "aux") {
  // The id is already on the model — `LanguageModel` is either a V2/V3 object,
  // which carries `modelId`, or the id itself. So the memo needs no new parameter
  // threaded through generateChatTitle, the memory-doc builders and their stores.
  const modelId = typeof model === "string" ? model : model.modelId;
  // A model that has already refused reasoning gets no knob at all — not even the
  // suppression one. Suppressing reasoning still SENDS a reasoning parameter
  // (`reasoningEffort: "low"`, `thinking: disabled`), which is what such a model
  // rejects, so asking it to think less costs a whole wasted request per aux call.
  // `.catch(() => false)` deliberately: the memo is an optimisation, and these
  // calls had no database dependency before it. A catalog read that fails must
  // cost one wasted request, not a missing chat title — the same reason the write
  // below is fire-and-forget.
  const cannotReason = await getModelCannotReason(modelId).catch(() => false);
  const providerOptions = cannotReason ? undefined : auxReasoningOptions(provider);
  const telemetry = telemetryFor(`capka.aux.${label}`);
  // ROOT_CONTEXT, not the caller's context: aux work is fire-and-forget and
  // OUTLIVES the turn that spawned it (that is what trackAux/auxInFlight exist
  // for). As a child span it would outlive its own parent, which renders as a
  // corrupt trace — so each aux call becomes its own root, correlated by the
  // session id instead.
  return withoutParentContext(async () => {
    try {
      return await generateText({ model, ...args, abortSignal: AbortSignal.timeout(AUX_TIMEOUT_MS), experimental_telemetry: telemetry, ...(providerOptions ? { providerOptions: providerOptions as never } : {}) });
    } catch (e) {
      if (providerOptions && isReasoningUnsupportedError(e)) {
        // Same memo the runner writes and reads, so whichever path meets the model
        // first pays the rejection once and the other never pays it at all.
        void rememberModelCannotReason(modelId, provider).catch((err) =>
          log.warn("could not persist that the model cannot reason", { err: String(err) }),
        );
        return await generateText({ model, ...args, abortSignal: AbortSignal.timeout(AUX_TIMEOUT_MS), experimental_telemetry: telemetry });
      }
      throw e;
    }
  });
}
