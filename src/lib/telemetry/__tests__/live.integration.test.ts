/**
 * End-to-end export through the real OTLP exporter into a local collector stub,
 * asserting on the BYTES that leave the process.
 *
 * Why a local HTTP server instead of stubbing fetch: the protobuf exporter uses
 * node:http, not global fetch, so a fetch stub sees nothing. This is also the
 * only test that exercises the real serializer — the unit tests stop at the
 * sanitizer.
 *
 * Gated on RUN_INTEGRATION=1 because it binds a port.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { SpanStatusCode, trace, context } from "@opentelemetry/api";

const CANARY = `canary-${Date.now()}-quarterly-salaries.xlsx`;

type Globals = { __capkaTelemetry?: unknown; __capkaTelemetryConfig?: unknown };
function resetTelemetry() {
  const g = globalThis as Globals;
  delete g.__capkaTelemetry;
  delete g.__capkaTelemetryConfig;
  trace.disable();
  context.disable();
}

/** An OTLP/HTTP receiver that records raw request bodies. */
async function collectorStub(): Promise<{ url: string; bodies: () => string; close: () => Promise<void>; server: Server }> {
  const chunks: Buffer[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      chunks.push(Buffer.concat(parts));
      res.writeHead(200, { "Content-Type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    // latin1 keeps every byte inspectable as a character, so a plain substring
    // search over the protobuf frame is valid for ASCII canaries.
    bodies: () => Buffer.concat(chunks).toString("latin1"),
    close: () => new Promise<void>((r) => server.close(() => r())),
    server,
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  resetTelemetry();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.CAPKA_TELEMETRY_CONTENT;
  delete process.env.CAPKA_TELEMETRY_COST;
});

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("OTLP export — bytes on the wire", () => {
  it("ships turn structure and safe metadata, and no user content", async () => {
    const collector = await collectorStub();
    cleanup = collector.close;
    resetTelemetry();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.url;

    const { startTelemetry, shutdownTelemetry, withTurnSpan, withChildSpan, setTurnOutcome, sanitizeRoute } =
      await import("../index");
    await startTelemetry();

    await withTurnSpan(
      { taskId: "task_live", chatId: "chat_live", userId: "user_live", workerId: "w1", channel: "web" },
      async () => {
        await withChildSpan("ai.toolCall", { "ai.toolCall.name": "run_command" }, async () => {
          await withChildSpan(
            "capka.sandbox.request",
            {
              // The real leak vector: a path whose query carries a workspace token.
              "capka.sandbox.route": sanitizeRoute(`/sessions/chat_live/exec?token=${CANARY}`),
              "capka.sandbox.method": "POST",
            },
            async (span) => span.setAttribute("capka.sandbox.status", 200),
          );
        });

        // The three places the AI SDK writes content the flags do NOT gate.
        const llm = trace.getTracer("capka").startSpan("ai.streamText");
        llm.setAttribute("ai.model.id", "claude-opus-5");
        llm.setAttribute("ai.prompt.messages", CANARY);
        llm.recordException(new Error(`provider rejected: ${CANARY}`));
        llm.setStatus({ code: SpanStatusCode.ERROR, message: `400: ${CANARY}` });
        llm.end();

        setTurnOutcome({
          status: "completed",
          usage: { input: 4211, output: 318, cached: 3900 },
          contextTokens: 4211,
          costUsd: 0.0412,
          costSource: "provider",
          tools: 1,
          modelFinal: "claude-opus-5",
        });
      },
    );

    await shutdownTelemetry();
    const wire = collector.bodies();

    expect(wire.length).toBeGreaterThan(0);
    // The whole point of the privacy model: not via a prompt attribute, not via
    // an exception event, not via a status message, not via a URL query.
    expect(wire).not.toContain(CANARY);
    // Structure and safe metadata did go out.
    expect(wire).toContain("capka.turn");
    expect(wire).toContain("invoke_agent");
    expect(wire).toContain("/sessions/{id}/exec");
    expect(wire).toContain("capka.usage.input_tokens");
    expect(wire).toContain("claude-opus-5");
    // Cost stays ours unless an operator opts in.
    expect(wire).not.toContain("capka.cost.usd");
  }, 30_000);

  it("keeps framework spans out of the export", async () => {
    const collector = await collectorStub();
    cleanup = collector.close;
    resetTelemetry();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.url;

    const { startTelemetry, shutdownTelemetry } = await import("../index");
    await startTelemetry();

    const span = trace.getTracer("next").startSpan("GET /api/chats");
    span.setAttribute("http.route", "/api/chats");
    span.end();
    const ours = trace.getTracer("capka").startSpan("capka.turn");
    ours.end();

    await shutdownTelemetry();
    const wire = collector.bodies();

    expect(wire).toContain("capka.turn");
    expect(wire).not.toContain("GET /api/chats");
  }, 30_000);
});
