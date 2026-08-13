/**
 * Telemetry configuration, resolved from the STANDARD OTel environment
 * variables — we deliberately add no Capka-specific aliases for anything OTel
 * already specifies, so an operator's existing collector config just works.
 *
 * Pure and total, like `config/check.ts`: never throws, never reads the network.
 * The whole point is that the two content flags below can be reasoned about (and
 * tested) without standing up an exporter.
 */

export interface ContentPolicy {
  /** Whether prompts/completions/tool payloads may be recorded at all. */
  enabled: boolean;
  /** Set only when content was REQUESTED but denied — the reason to log. */
  blockedReason?: string;
}

/** Wire formats we can actually produce. gRPC would need another dependency. */
export type OtlpProtocol = "http/protobuf" | "http/json";

export interface TelemetryConfig {
  enabled: boolean;
  /** Absolute URL to POST spans to; empty when disabled. */
  tracesUrl: string;
  headers: Record<string, string>;
  content: ContentPolicy;
  protocol: OtlpProtocol;
  /** The requested-but-unsupported protocol, so the caller can report it. */
  unsupportedProtocol?: string;
  /**
   * Span-name prefixes to export. Empty array = export everything. Configurable
   * because the useful scope changes as the ecosystem does: today only our own
   * and the AI SDK's spans are wanted, but an operator who also runs a Next.js
   * APM should not need a fork to widen it.
   */
  spanNamePrefixes: string[];
  /**
   * Extra attribute keys (or `prefix.` forms) to admit past the allowlist. The
   * GenAI conventions are still experimental and moving; this lets an operator
   * keep up without waiting on a Capka release. Operator's responsibility.
   */
  extraAllowedAttributes: string[];
  /**
   * Whether to also export the dollar cost. Off by default: the `usage` ledger
   * (with its pending holds and shared-vs-own-key semantics) is this project's
   * money truth, and a second figure in a tracing backend would be a second
   * answer to the same question. Turn on if you would rather consolidate there.
   */
  includeCost: boolean;
}

/**
 * Only agent work by default. Registering a tracer provider is global, so Next.js
 * (and anything else carrying @opentelemetry/api) starts emitting spans too.
 */
export const DEFAULT_SPAN_PREFIXES = ["capka.", "ai."];

/** `a, b.` → `["a", "b."]`; blank entries dropped. */
function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Reduces a controller path to a low-cardinality route template.
 *
 * Deliberately positional rather than a lookup table of known endpoints: paths
 * here carry session keys, user ids, filenames, user-chosen MCP server names,
 * and — on DELETE /sessions — a `workspaceToken` in the query string. A table
 * would leak every endpoint nobody remembered to add, so the rule instead masks
 * every id slot and drops the query entirely. A new endpoint is therefore safe
 * by default, at the cost of masking action words in id position too.
 */
export function sanitizeRoute(path: string): string {
  const [withoutQuery] = path.split("?");
  const segments = withoutQuery.split("/").filter(Boolean);
  return "/" + segments.map((seg, i) => (i % 2 === 1 ? "{id}" : seg)).join("/");
}

/** OTLP header env format: `k1=v1,k2=v2`. Values may contain `=` (base64 auth). */
function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * "Local" means the trace data does not leave this host/network. Used ONLY to
 * decide whether content capture needs a second, explicit acknowledgement —
 * never as a security boundary in its own right. Matching is on the parsed
 * hostname, not a substring, so `localhost.evil.example.com` is correctly
 * treated as remote.
 */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||                          // loopback
    a === 10 ||                           // RFC1918
    (a === 172 && b >= 16 && b <= 31) ||  // RFC1918
    (a === 192 && b === 168) ||           // RFC1918
    (a === 169 && b === 254)              // link-local
  );
}

export function resolveTelemetryConfig(
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  // `*` means "no name filtering"; anything else is a comma-separated prefix list.
  const rawPrefixes = env.CAPKA_TELEMETRY_SPAN_PREFIXES?.trim();
  const spanNamePrefixes =
    rawPrefixes === "*" ? [] : rawPrefixes ? parseList(rawPrefixes) : DEFAULT_SPAN_PREFIXES;
  const extraAllowedAttributes = parseList(env.CAPKA_TELEMETRY_EXTRA_ATTRIBUTES);
  const includeCost = env.CAPKA_TELEMETRY_COST?.trim() === "true";

  const requested = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim();
  const protocol: OtlpProtocol = requested === "http/json" ? "http/json" : "http/protobuf";
  const unsupportedProtocol =
    requested && requested !== "http/json" && requested !== "http/protobuf" ? requested : undefined;

  const off: TelemetryConfig = {
    enabled: false,
    tracesUrl: "",
    headers: {},
    content: { enabled: false },
    protocol,
    spanNamePrefixes,
    extraAllowedAttributes,
    includeCost,
    ...(unsupportedProtocol ? { unsupportedProtocol } : {}),
  };

  // Standard kill switches win over any endpoint being present.
  if (env.OTEL_SDK_DISABLED?.trim() === "true") return off;
  const exporter = env.OTEL_TRACES_EXPORTER?.trim();
  if (exporter && exporter !== "otlp") return off;

  // A signal-specific endpoint is used VERBATIM; only the generic base gets the
  // `/v1/traces` suffix. Conflating the two is the classic OTLP misconfiguration
  // (it yields `…/v1/traces/v1/traces`).
  const signal = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const raw = signal || base;
  if (!raw) return off;

  let url: URL;
  try {
    url = new URL(signal ? signal : `${base!.replace(/\/+$/, "")}/v1/traces`);
  } catch {
    return off;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return off;

  const headers = {
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };

  // Fail-closed content policy. One flag is enough only while the data stays on
  // this host/network; shipping chat content to a third party takes a second,
  // separate acknowledgement. When the operator asks for the unsafe combination
  // we DENY and report — `reportConfig()` is advisory and never blocks boot, so
  // enforcement has to live here.
  const wants = env.CAPKA_TELEMETRY_CONTENT?.trim() === "true";
  const local = isLocalHost(url.hostname);
  const acked = env.CAPKA_TELEMETRY_CONTENT_REMOTE?.trim() === "true";
  const content: ContentPolicy =
    !wants ? { enabled: false }
    : local || acked ? { enabled: true }
    : {
        enabled: false,
        blockedReason:
          `CAPKA_TELEMETRY_CONTENT=true was ignored: ${url.hostname} is not this host, and ` +
          `sending prompts, documents, and tool output there also requires ` +
          `CAPKA_TELEMETRY_CONTENT_REMOTE=true.`,
      };

  return { ...off, enabled: true, tracesUrl: url.toString(), headers, content };
}

/**
 * Builds the AI SDK's `experimental_telemetry` value. The ONLY place that value
 * is constructed — `recordInputs`/`recordOutputs` are always stated explicitly,
 * because the SDK treats an omitted flag as `true` and would record prompts,
 * tool arguments, and tool results by default.
 */
export function telemetrySettingsFrom(
  config: TelemetryConfig,
  functionId: string,
  metadata?: Record<string, string | number | boolean>,
): {
  isEnabled: boolean;
  functionId: string;
  recordInputs: boolean;
  recordOutputs: boolean;
  metadata?: Record<string, string | number | boolean>;
} {
  return {
    isEnabled: config.enabled,
    functionId,
    recordInputs: config.content.enabled,
    recordOutputs: config.content.enabled,
    ...(metadata ? { metadata } : {}),
  };
}
