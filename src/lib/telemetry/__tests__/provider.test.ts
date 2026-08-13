import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { startTelemetry, shutdownTelemetry, telemetryEnabled, telemetryFor } from "../index";

type Globals = { __capkaTelemetry?: unknown; __capkaTelemetryConfig?: unknown };

function resetTelemetryGlobals() {
  const g = globalThis as Globals;
  delete g.__capkaTelemetry;
  delete g.__capkaTelemetryConfig;
}

beforeEach(resetTelemetryGlobals);

afterEach(async () => {
  await shutdownTelemetry();
  resetTelemetryGlobals();
  trace.disable();
  context.disable();
  vi.unstubAllEnvs();
});

describe("startTelemetry", () => {
  it("does nothing when no endpoint is configured", async () => {
    await startTelemetry();

    expect(telemetryEnabled()).toBe(false);
    // No provider registered ⇒ the API hands back a non-recording span.
    expect(trace.getTracer("t").startSpan("x").isRecording()).toBe(false);
  });

  it("registers exactly one provider even when called concurrently or twice", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");

    await Promise.all([startTelemetry(), startTelemetry()]);
    await startTelemetry();

    expect(telemetryEnabled()).toBe(true);
    // A second registration would replace the global provider; identity proves it did not.
    const first = trace.getTracerProvider();
    await startTelemetry();
    expect(trace.getTracerProvider()).toBe(first);
  });

  it("produces recording spans once registered, so instrumentation is actually live", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");
    await startTelemetry();

    expect(trace.getTracer("capka").startSpan("capka.turn").isRecording()).toBe(true);
  });

  it("survives an unusable endpoint without throwing, so boot is never blocked", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://192.0.2.1:1/nowhere");

    await expect(startTelemetry()).resolves.toBeUndefined();
  });
});

describe("shutdownTelemetry", () => {
  it("is a no-op when telemetry was never started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe("telemetryFor", () => {
  it("keeps content off by default, reading the live environment", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318");

    const s = telemetryFor("capka.turn.llm", { "capka.task.id": "t1" });
    expect(s.isEnabled).toBe(true);
    expect(s.recordInputs).toBe(false);
    expect(s.recordOutputs).toBe(false);
    expect(s.metadata).toEqual({ "capka.task.id": "t1" });
  });

  it("reports disabled when nothing is configured", () => {
    expect(telemetryFor("capka.turn.llm").isEnabled).toBe(false);
  });
});
