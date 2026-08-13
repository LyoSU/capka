/**
 * Whether to ask an OpenAI-compatible endpoint to report token usage on a stream.
 *
 * On the streaming path, `usage` is optional in the OpenAI wire protocol: a
 * server reports it only if the request carries
 * `stream_options: {include_usage: true}`. Without the ask, gateways that follow
 * the spec strictly (a LiteLLM proxy in front of a custom model, vLLM, …) stream a
 * complete reply and finish with NO usage at all — so the turn is recorded, billed,
 * and traced as zero tokens, and the ledger silently under-counts real spend.
 *
 * The ask cannot be made unconditionally, though: several backends validate the
 * request body strictly and reject an unknown field (see
 * `isStreamUsageRejectedError` for the wordings). We can't know which up front —
 * behind a proxy, the model's real backend isn't even visible — so we ask
 * optimistically and learn the answer from the rejection, the same optimistic-
 * then-fallback shape the runner already uses for reasoning and attachments.
 *
 * The memory is per CONNECTION (a config row: one endpoint + one key), not per
 * provider name: two `litellm` connections can point at gateways that disagree.
 * It lives in memory and resets on restart, which costs one rejected request per
 * connection per process and — more importantly — self-heals when the operator
 * upgrades a gateway that used to refuse.
 */

// On globalThis for the same reason the worker's state is: Next dev/HMR re-imports
// modules, and a second Set would forget what the first one already learned.
const g = globalThis as unknown as { __capkaNoStreamUsage?: Set<string> };
const refused = (g.__capkaNoStreamUsage ??= new Set<string>());

/**
 * Whether to send the ask for this connection. Off either because the endpoint
 * refused it, or because the operator switched it off — the escape hatch for a
 * backend that breaks on the parameter in some way the classifier doesn't catch
 * (the cost of switching it off is unbilled turns, so it is documented as a last
 * resort, not a tuning knob).
 */
export function streamUsageEnabled(connectionKey: string): boolean {
  return process.env.CAPKA_STREAM_USAGE?.trim() !== "false" && !refused.has(connectionKey);
}

/**
 * Remember that this endpoint refuses the ask. Returns true only when this call
 * actually changed something — the runner gates its single re-stream on that, so a
 * rejection that survives the retry surfaces instead of looping.
 */
export function disableStreamUsage(connectionKey: string): boolean {
  if (!streamUsageEnabled(connectionKey)) return false;
  refused.add(connectionKey);
  return true;
}

/**
 * Wired as the SDK's `transformRequestBody`. It only ever REMOVES the field: the
 * SDK inserts `stream_options` on the streaming path alone, so stripping (rather
 * than adding it ourselves) is what guarantees a non-streaming request can never
 * carry a parameter that only means anything on a stream.
 */
export function withoutStreamUsage(
  connectionKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (streamUsageEnabled(connectionKey)) return body;
  const stripped = { ...body };
  delete stripped.stream_options;
  return stripped;
}
