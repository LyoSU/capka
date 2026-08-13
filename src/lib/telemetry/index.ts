/**
 * Public telemetry surface. Everything the rest of the app touches lives here,
 * so the two moving targets underneath — the OTel GenAI conventions and the AI
 * SDK's telemetry API (v7 replaces `experimental_telemetry` with registered
 * integrations) — stay one-file changes.
 *
 * Off unless an OTLP endpoint is configured, in which case every helper degrades
 * to a no-op and no SDK module is even imported.
 */
import { resolveTelemetryConfig, telemetrySettingsFrom, type TelemetryConfig } from "./config";
import type { Registration } from "./provider";

export { sanitizeRoute } from "./config";
export {
  withTurnSpan,
  setTurnOutcome,
  endActiveTurnSpans,
  withoutParentContext,
  withChildSpan,
  type TurnSpanInput,
  type TurnOutcome,
  type TurnStatus,
} from "./spans";

/**
 * Process-wide state on globalThis, matching the worker's pattern: Next dev/HMR
 * re-imports modules, and module-level state would let a second provider replace
 * the first (losing every span still queued in the old one).
 */
interface State {
  registration?: Registration;
  starting?: Promise<void>;
}
const g = globalThis as unknown as { __capkaTelemetry?: State; __capkaTelemetryConfig?: TelemetryConfig };

const state = (): State => (g.__capkaTelemetry ??= {});

/** Resolved once per process — env does not change under a running server. */
function config(): TelemetryConfig {
  return (g.__capkaTelemetryConfig ??= resolveTelemetryConfig());
}

export function telemetryEnabled(): boolean {
  return config().enabled;
}

/**
 * The ONLY way to build an AI SDK `experimental_telemetry` value. No call site
 * writes that object itself: the SDK treats an omitted recordInputs/recordOutputs
 * as `true`, so a hand-written literal is one forgotten field away from shipping
 * prompts and tool results to a third party.
 */
export function telemetryFor(functionId: string, metadata?: Record<string, string | number | boolean>) {
  return telemetrySettingsFrom(config(), functionId, metadata);
}

/**
 * Registers the tracer provider. Idempotent and concurrency-safe: callers share
 * one in-flight promise, and a completed registration is never replaced. Never
 * throws — a broken telemetry endpoint must not stop the server from booting.
 */
export async function startTelemetry(): Promise<void> {
  const s = state();
  if (s.registration) return;
  if (s.starting) return s.starting;
  if (!config().enabled) return;

  s.starting = (async () => {
    try {
      const { registerProvider } = await import("./provider");
      s.registration = await registerProvider(config());
    } catch (e) {
      const { log } = await import("@/lib/log");
      log.error("telemetry failed to start (continuing without it)", { err: String(e) });
    } finally {
      s.starting = undefined;
    }
  })();
  return s.starting;
}

/**
 * Flushes and stops the exporter. Bounded, because it runs inside the worker's
 * shutdown budget (DRAIN_GRACE_MS 25s + this must stay under the platform's
 * 35s stop_grace_period) — a hung collector must not cost us the whole window.
 */
export async function shutdownTelemetry(timeoutMs = 5_000): Promise<void> {
  const s = state();
  const registration = s.registration;
  if (!registration) return;
  s.registration = undefined;

  const { log } = await import("@/lib/log");
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs).unref?.());
  try {
    const outcome = await Promise.race([registration.shutdown().then(() => "flushed" as const), timeout]);
    if (outcome === "timeout") log.warn("telemetry flush timed out; dropping pending spans", { timeoutMs });
  } catch (e) {
    log.warn("telemetry flush failed", { err: String(e) });
  }
}
