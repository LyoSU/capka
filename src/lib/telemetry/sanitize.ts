/**
 * Deny-by-default span scrubbing, applied at the exporter — the last point
 * before bytes leave this process.
 *
 * Why an allowlist rather than "turn off the SDK's two content flags": those
 * flags only gate attributes routed through the SDK's own selectTelemetryAttributes.
 * `recordErrorOnSpan` writes `error.message`, `error.stack`, and `status.message`
 * outside them entirely, and provider error bodies in this codebase demonstrably
 * quote back parts of the request (that is exactly why retryOnCapabilityError
 * exists). A future SDK version adding a new content attribute would also leak
 * through a denylist. So: known-safe keys pass, everything else is dropped.
 */
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { DEFAULT_SPAN_PREFIXES } from "./config";

/**
 * Exact `ai.*` keys that carry structure or numbers, never payloads. Taken from
 * the SDK's own attribute list; anything not enumerated here is dropped, so the
 * default for a newly-introduced SDK attribute is "not exported".
 */
const AI_SAFE = new Set([
  "ai.model.id",
  "ai.model.provider",
  "ai.operationId",
  "ai.telemetry.functionId",
  "ai.response.finishReason",
  "ai.response.id",
  "ai.response.model",
  "ai.response.timestamp",
  "ai.response.msToFinish",
  "ai.response.msToFirstChunk",
  "ai.response.avgOutputTokensPerSecond",
  "ai.stream.msToFirstChunk",
  "ai.toolCall.name",
  "ai.toolCall.id",
]);

/** `ai.usage.*` is uniformly numeric (token counts and their breakdowns). */
const AI_SAFE_PREFIXES = ["ai.usage."];

/**
 * Keys that MAY carry user content and are therefore admitted only when content
 * capture is active. Tool schemas/descriptions are included because a private
 * MCP connector's tool descriptions are not ours to publish.
 */
const CONTENT_KEYS = new Set([
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.prompt.toolChoice",
  "ai.response.text",
  "ai.response.object",
  "ai.response.reasoning",
  "ai.response.toolCalls",
  "ai.response.providerMetadata",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "ai.schema",
  "ai.schema.name",
  "ai.schema.description",
  "ai.documents",
  "ai.embedding",
  "ai.embeddings",
  // Ours: the sandbox command is the user's work, so it lives behind the same gate.
  "capka.sandbox.command",
]);

/**
 * Vendor correlation markers we set ourselves. Enumerated rather than allowing the
 * whole `langfuse.` namespace, because that namespace also has input/output fields
 * that carry message content. Verified against a live backend: stripping these
 * made Langfuse report sessionId: None and stopped it grouping a chat's turns.
 */
const VENDOR_SAFE = new Set([
  "langfuse.session.id",
  "langfuse.user.id",
  "langfuse.observation.type",
  "langfuse.trace.name",
  "langfuse.tags",
]);

/** GenAI convention keys that hold message content rather than metadata. */
const GEN_AI_CONTENT_PREFIXES = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input",
  "gen_ai.output",
  "gen_ai.system_instructions",
];

/**
 * Keys we deliberately do NOT export by default because this repo already owns
 * them better. Cost lives in the `usage` ledger with pending holds and
 * shared-vs-own-key semantics; shipping a second dollar figure to a tracing
 * backend creates two answers to "what did this cost". Opt in per deployment if
 * you would rather consolidate there — and then drop it on our side.
 */
const OWNED_ELSEWHERE_KEYS = new Set(["capka.cost.usd", "capka.cost.source"]);

export interface SanitizeOptions {
  /** Extra keys/`prefix.` forms an operator allowed past the allowlist. */
  extraAllowed?: readonly string[];
  /** Export the dollar figures too (off by default — see OWNED_ELSEWHERE_KEYS). */
  includeCost?: boolean;
}

function isAllowed(key: string, content: boolean, opts: SanitizeOptions): boolean {
  const extra = opts.extraAllowed ?? [];
  if (OWNED_ELSEWHERE_KEYS.has(key)) return opts.includeCost === true;
  // Content keys are checked FIRST so an operator extension can never become a
  // privacy bypass: widening the allowlist must not defeat the content gate.
  if (CONTENT_KEYS.has(key)) return content;
  if (GEN_AI_CONTENT_PREFIXES.some((p) => key.startsWith(p))) return content;
  // Our own namespace is trusted: every capka.* key is one this repo sets
  // deliberately, and the content-bearing exceptions are listed above.
  if (key.startsWith("capka.")) return true;
  if (key.startsWith("gen_ai.")) return true;
  if (key === "error.type") return true;
  if (VENDOR_SAFE.has(key)) return true;
  // Everything else under a vendor namespace is denied: `langfuse.observation.input`
  // and friends are message content.
  if (key.startsWith("langfuse.")) return content;
  if (AI_SAFE.has(key)) return true;
  if (AI_SAFE_PREFIXES.some((p) => key.startsWith(p))) return true;
  // Operator-supplied additions: an exact key, or a `prefix.` form.
  return extra.some((e) => (e.endsWith(".") ? key.startsWith(e) : key === e));
}

/**
 * The AI SDK records token counts under its own camelCase namespace, while every
 * backend (and the GenAI conventions) read `gen_ai.usage.*`. Live-verified: without
 * this translation a generation arrives with usage {input: 0, output: 0}, i.e. an
 * empty token graph that looks like a backend bug. Applied only to the SDK's own
 * model-call spans — putting these on the turn root would make it a second
 * generation holding the sum of its children.
 */
const USAGE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["ai.usage.inputTokens", "gen_ai.usage.input_tokens"],
  ["ai.usage.outputTokens", "gen_ai.usage.output_tokens"],
  ["ai.usage.cachedInputTokens", "gen_ai.usage.cache_read.input_tokens"],
  ["ai.usage.inputTokenDetails.cacheWriteTokens", "gen_ai.usage.cache_creation.input_tokens"],
];

/**
 * Returns a span equivalent to `span` with disallowed data removed. Span
 * identity (trace/span ids, parent, name, kind, timings) is preserved verbatim
 * so the trace tree stays intact — scrubbing must not orphan children.
 *
 * A new object rather than an in-place edit: ReadableSpan is contractually
 * read-only, and other processors may hold the original.
 */
export function sanitizeSpan(
  span: ReadableSpan,
  content: boolean,
  options: SanitizeOptions = {},
): ReadableSpan {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (isAllowed(key, content, options)) attributes[key] = value;
  }

  // Only where the SDK actually reports usage, never on our own turn span.
  if (span.name.startsWith("ai.")) {
    for (const [from, to] of USAGE_ALIASES) {
      const value = span.attributes[from];
      if (typeof value === "number" && attributes[to] === undefined) attributes[to] = value;
    }
  }

  // Every field is listed explicitly rather than spread from `span`. Spreading a
  // live SDK span also copies its internals (which reference the tracer and its
  // config, i.e. a cyclic graph), which both defeats the point of an allowlist
  // and cannot be serialized.
  return {
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    name: span.name,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    links: span.links,
    attributes,
    // recordException writes the message and stack as an EVENT, so dropping
    // events is what actually removes them. The safe classification survives as
    // capka.error.category / error.type attributes.
    events: content ? span.events : [],
    // status.message is free-form provider text; the code alone is safe.
    status: content ? span.status : { code: span.status.code },
  };
}

/**
 * Registering a tracer provider is a global act: Next.js starts emitting its own
 * request spans, and drizzle/better-auth also carry @opentelemetry/api. The
 * approved scope is agent work only, so only our namespaces are forwarded.
 */
export function shouldExportSpan(name: string, prefixes: readonly string[] = DEFAULT_SPAN_PREFIXES): boolean {
  // No prefixes configured (`CAPKA_TELEMETRY_SPAN_PREFIXES=*`) means export all.
  return prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
}

/**
 * Wraps a real exporter so every span is scrubbed on the way out. The policy is
 * read per export (not captured once) so configuration resolved after
 * construction still applies.
 */
export function sanitizingExporter(
  inner: SpanExporter,
  contentEnabled: () => boolean,
  options: () => SanitizeOptions = () => ({}),
): SpanExporter {
  return {
    export(spans, resultCallback) {
      const content = contentEnabled();
      const opts = options();
      inner.export(spans.map((s) => sanitizeSpan(s, content, opts)), resultCallback);
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}
