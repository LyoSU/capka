/**
 * Provider-native context-management knobs, kept separate from our own
 * checkpoint compaction so the two layers compose. Some providers can clear or
 * compact context server-side, cache-coherently — far better than us mutating
 * the prefix client-side. Today only Anthropic exposes this; the switch is the
 * extension point for OpenAI/Google equivalents as they ship, without touching
 * the runner.
 *
 * We use Anthropic's `clear_tool_uses` (drop old tool results in the FRESH zone
 * between checkpoints — the cheap lever our LLM compaction doesn't cover) but
 * deliberately NOT their native `compact_20260112`: our checkpoint compaction is
 * the single cross-provider mechanism, so the conversation tree and UX stay
 * identical regardless of provider.
 */

/**
 * The tool-result clearing policy, in ONE place. Anthropic enforces it
 * server-side through the edit below; every other provider gets the same policy
 * applied to the context we build (`buildModelContext`'s `clearToolsKeepLast` —
 * see the runner). Kept shared so the behaviour can't fork by provider, and so
 * moving the threshold moves both halves at once.
 *
 * Fires well before the 75% compaction threshold: shedding stale tool bodies is
 * the cheap relief, and compaction handles whatever is left.
 */
export const TOOL_CLEAR_TRIGGER_FRACTION = 0.5;
/** How many of the most recent tool results keep their bodies. */
export const TOOL_CLEAR_KEEP_LAST = 3;

/** True when the provider has no server-side tool-result clearing, so we must
 *  apply the policy ourselves when building the model's view of the context. */
export function clearsToolResultsClientSide(provider: string): boolean {
  return contextManagementOptions(provider, 0) === undefined;
}
export function contextManagementOptions(
  provider: string,
  effectiveLimit: number,
): Record<string, unknown> | undefined {
  switch (provider) {
    case "anthropic":
      return {
        anthropic: {
          contextManagement: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: Math.round(effectiveLimit * TOOL_CLEAR_TRIGGER_FRACTION) },
                keep: { type: "tool_uses", value: TOOL_CLEAR_KEEP_LAST },
                clearAtLeast: { type: "input_tokens", value: 1000 },
              },
            ],
          },
        },
      };
    default:
      return undefined;
  }
}

/** A provider-options object: a map of provider name → that provider's options. */
type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Deep-merge provider-options objects one level into each provider namespace,
 * so reasoning, context-management, and caching knobs that all target e.g.
 * `anthropic` combine into one `{ anthropic: { thinking, contextManagement, … } }`
 * instead of clobbering each other. Returns undefined when all are empty.
 */
export function mergeProviderOptions(
  ...opts: (ProviderOptions | undefined)[]
): ProviderOptions | undefined {
  let out: ProviderOptions | undefined;
  for (const o of opts) {
    if (!o) continue;
    if (!out) {
      out = { ...o };
      continue;
    }
    for (const [provider, po] of Object.entries(o)) {
      out[provider] = { ...(out[provider] ?? {}), ...po };
    }
  }
  return out;
}
