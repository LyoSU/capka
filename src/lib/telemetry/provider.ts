/**
 * Tracer-provider registration. Everything here is imported lazily and only when
 * an endpoint is configured, so a deployment without telemetry pays nothing —
 * not even the module load.
 *
 * NodeTracerProvider rather than @opentelemetry/sdk-node: the latter pulls the
 * whole auto-instrumentation tree, which would turn this into an APM against the
 * agreed scope. NodeTracerProvider is also what installs the AsyncLocalStorage
 * context manager — without one, context.active() is always root and no child
 * span ever attaches to a turn.
 */
import { diag, DiagLogLevel } from "@opentelemetry/api";
import { log } from "@/lib/log";
import { shouldExportSpan, sanitizingExporter } from "./sanitize";
import type { TelemetryConfig } from "./config";

export interface Registration {
  shutdown: () => Promise<void>;
}

/**
 * Routes the OTel SDK's own diagnostics into our structured log, deduplicated by
 * message. The SDK writes to its `diag` channel, not to `log.ts`, so without this
 * an unreachable collector is either silent or an unbounded console spam — and
 * both are worse than one line per distinct problem.
 */
function bridgeDiagnostics(): void {
  const seen = new Set<string>();
  const once = (level: "warn" | "error", msg: string) => {
    const key = `${level}:${msg}`;
    if (seen.has(key)) return;
    seen.add(key);
    log[level]("telemetry.sdk", { msg });
  };
  diag.setLogger(
    {
      error: (m) => once("error", m),
      warn: (m) => once("warn", m),
      // Info/debug/verbose are dropped: useful only when debugging the exporter,
      // and the SDK is chatty enough to drown the task log.
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    DiagLogLevel.WARN,
  );
}

export async function registerProvider(config: TelemetryConfig): Promise<Registration> {
  const [{ NodeTracerProvider }, { BatchSpanProcessor }, { resourceFromAttributes, defaultResource }, semconv] =
    await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
    ]);

  // One exporter module per wire format, chosen at runtime so an operator's
  // OTEL_EXPORTER_OTLP_PROTOCOL is honored rather than silently ignored.
  const { OTLPTraceExporter } =
    config.protocol === "http/json"
      ? await import("@opentelemetry/exporter-trace-otlp-http")
      : await import("@opentelemetry/exporter-trace-otlp-proto");

  bridgeDiagnostics();
  if (config.unsupportedProtocol) {
    log.warn("telemetry.protocol_unsupported", {
      requested: config.unsupportedProtocol,
      using: config.protocol,
    });
  }
  if (config.content.blockedReason) {
    log.error("telemetry.content_blocked", { reason: config.content.blockedReason });
  }

  const exporter = sanitizingExporter(
    new OTLPTraceExporter({ url: config.tracesUrl, headers: config.headers }),
    () => config.content.enabled,
    () => ({ extraAllowed: config.extraAllowedAttributes, includeCost: config.includeCost }),
  );

  const batch = new BatchSpanProcessor(exporter);
  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "capka",
        [semconv.ATTR_SERVICE_VERSION]: process.env.CAPKA_VERSION || "dev",
      }),
    ),
    spanProcessors: [
      {
        onStart: (span, ctx) => batch.onStart(span, ctx),
        // Name filtering happens here rather than in the exporter so unwanted
        // spans never enter the batch queue and cannot displace agent spans.
        onEnd: (span) => {
          if (shouldExportSpan(span.name, config.spanNamePrefixes)) batch.onEnd(span);
        },
        shutdown: () => batch.shutdown(),
        forceFlush: () => batch.forceFlush(),
      },
    ],
  });
  provider.register();

  log.info("telemetry.started", {
    endpoint: config.tracesUrl,
    protocol: config.protocol,
    content: config.content.enabled,
    prefixes: config.spanNamePrefixes.join(",") || "*",
  });

  return { shutdown: () => provider.shutdown() };
}
