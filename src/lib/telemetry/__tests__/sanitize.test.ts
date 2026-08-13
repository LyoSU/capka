import { describe, it, expect } from "vitest";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { sanitizeSpan, sanitizingExporter, shouldExportSpan } from "../sanitize";

/**
 * Produces a REAL ReadableSpan (no hand-rolled object literal), so the test
 * exercises the same shape the exporter actually receives.
 */
function makeSpan(name: string, fill: (span: Span) => void): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const span = provider.getTracer("test").startSpan(name);
  fill(span);
  span.end();
  const [finished] = exporter.getFinishedSpans();
  return finished;
}

const CANARY = "canary-quarterly-revenue-2026.xlsx";

describe("sanitizeSpan — with content capture OFF", () => {
  it("drops span events, which is where recordException puts the message and stack", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.recordException(new Error(`provider rejected: ${CANARY}`));
    });
    expect(span.events.length).toBe(1); // precondition: the SDK really did record it

    const clean = sanitizeSpan(span, false);
    expect(clean.events).toEqual([]);
  });

  it("keeps the status code but drops the status message", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.setStatus({ code: SpanStatusCode.ERROR, message: `400 while sending ${CANARY}` });
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.status.code).toBe(SpanStatusCode.ERROR);
    expect(clean.status.message).toBeUndefined();
  });

  it("leaves no trace of error text anywhere in the serialized span", () => {
    const span = makeSpan("capka.turn", (s) => {
      const err = new Error(`echoed reasoning_content: ${CANARY}`);
      s.recordException(err);
      s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      s.setAttribute("capka.error.category", "provider_rejected");
    });

    const clean = sanitizeSpan(span, false);
    expect(JSON.stringify(clean)).not.toContain(CANARY);
    // The safe classification survives — that is what makes stripping acceptable.
    expect(clean.attributes["capka.error.category"]).toBe("provider_rejected");
  });

  it("drops unknown ai.* keys, so a future SDK attribute cannot leak by default", () => {
    const span = makeSpan("ai.streamText", (s) => {
      s.setAttribute("ai.someFutureContentField", CANARY);
    });

    expect(sanitizeSpan(span, false).attributes["ai.someFutureContentField"]).toBeUndefined();
  });

  it("drops the SDK's prompt/response content attributes", () => {
    const span = makeSpan("ai.streamText", (s) => {
      s.setAttribute("ai.prompt.messages", CANARY);
      s.setAttribute("ai.response.text", CANARY);
      s.setAttribute("ai.toolCall.args", CANARY);
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.attributes["ai.prompt.messages"]).toBeUndefined();
    expect(clean.attributes["ai.response.text"]).toBeUndefined();
    expect(clean.attributes["ai.toolCall.args"]).toBeUndefined();
  });

  it("drops our own content-bearing attribute even though capka.* is otherwise trusted", () => {
    const span = makeSpan("capka.sandbox.request", (s) => {
      s.setAttribute("capka.sandbox.operation", "session.exec");
      s.setAttribute("capka.sandbox.command", `cat ${CANARY}`);
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.attributes["capka.sandbox.operation"]).toBe("session.exec");
    expect(clean.attributes["capka.sandbox.command"]).toBeUndefined();
  });

  it("keeps allowlisted structural and usage attributes", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.setAttribute("capka.task.id", "task_123");
      s.setAttribute("capka.usage.input_tokens", 4211);
      s.setAttribute("ai.toolCall.name", "run_command");
      s.setAttribute("gen_ai.operation.name", "invoke_agent");
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.attributes).toEqual({
      "capka.task.id": "task_123",
      "capka.usage.input_tokens": 4211,
      "ai.toolCall.name": "run_command",
      "gen_ai.operation.name": "invoke_agent",
    });
  });

  it("preserves span identity so the trace tree is not broken", () => {
    const span = makeSpan("capka.turn", (s) => s.setAttribute("capka.task.id", "t1"));

    const clean = sanitizeSpan(span, false);
    expect(clean.spanContext().traceId).toBe(span.spanContext().traceId);
    expect(clean.spanContext().spanId).toBe(span.spanContext().spanId);
    expect(clean.name).toBe(span.name);
    expect(clean.kind).toBe(span.kind);
    expect(clean.startTime).toEqual(span.startTime);
    expect(clean.endTime).toEqual(span.endTime);
    expect(clean.parentSpanContext).toEqual(span.parentSpanContext);
  });
});

describe("sanitizeSpan — with content capture ON", () => {
  it("keeps events and the status message", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.recordException(new Error("boom"));
      s.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
    });

    const clean = sanitizeSpan(span, true);
    expect(clean.events.length).toBe(1);
    expect(clean.status.message).toBe("boom");
  });

  it("admits the known content attributes", () => {
    const span = makeSpan("ai.streamText", (s) => {
      s.setAttribute("ai.prompt.messages", "[{...}]");
      s.setAttribute("capka.sandbox.command", "ls -la");
    });

    const clean = sanitizeSpan(span, true);
    expect(clean.attributes["ai.prompt.messages"]).toBe("[{...}]");
    expect(clean.attributes["capka.sandbox.command"]).toBe("ls -la");
  });

  it("still drops unknown keys — content capture is not a blanket pass", () => {
    const span = makeSpan("ai.streamText", (s) => s.setAttribute("ai.someFutureContentField", "x"));

    expect(sanitizeSpan(span, true).attributes["ai.someFutureContentField"]).toBeUndefined();
  });
});

describe("shouldExportSpan — keeping 'no APM' true", () => {
  it("forwards our own and the AI SDK's spans", () => {
    expect(shouldExportSpan("capka.turn")).toBe(true);
    expect(shouldExportSpan("capka.sandbox.request")).toBe(true);
    expect(shouldExportSpan("ai.streamText")).toBe(true);
    expect(shouldExportSpan("ai.toolCall")).toBe(true);
  });

  it("drops framework spans, which appear the moment a tracer provider exists", () => {
    // Registering any provider makes Next.js emit these; the approved scope excludes them.
    expect(shouldExportSpan("GET /api/chats")).toBe(false);
    expect(shouldExportSpan("resolve page components")).toBe(false);
    expect(shouldExportSpan("pg.query")).toBe(false);
  });
});

describe("sanitizingExporter", () => {
  it("hands the inner exporter scrubbed spans only", async () => {
    const inner = new InMemorySpanExporter();
    const exporter = sanitizingExporter(inner, () => false);
    const span = makeSpan("capka.turn", (s) => {
      s.recordException(new Error(CANARY));
      s.setAttribute("capka.task.id", "t1");
      s.setAttribute("ai.prompt.messages", CANARY);
    });

    await new Promise<void>((resolve) => exporter.export([span], () => resolve()));

    const [exported] = inner.getFinishedSpans();
    expect(exported.attributes["capka.task.id"]).toBe("t1");
    expect(exported.attributes["ai.prompt.messages"]).toBeUndefined();
    expect(exported.events).toEqual([]);
    expect(JSON.stringify(inner.getFinishedSpans())).not.toContain(CANARY);
  });

  it("re-reads the policy per export, so it cannot be captured at construction time", async () => {
    const inner = new InMemorySpanExporter();
    let content = false;
    const exporter = sanitizingExporter(inner, () => content);
    const span = makeSpan("capka.turn", (s) => s.setAttribute("ai.prompt.messages", "hello"));

    await new Promise<void>((r) => exporter.export([span], () => r()));
    expect(inner.getFinishedSpans()[0].attributes["ai.prompt.messages"]).toBeUndefined();

    content = true;
    inner.reset();
    await new Promise<void>((r) => exporter.export([span], () => r()));
    expect(inner.getFinishedSpans()[0].attributes["ai.prompt.messages"]).toBe("hello");
  });
});

describe("configurability — growing without a fork", () => {
  it("filters by the caller's prefixes, and treats an empty list as no filtering", () => {
    expect(shouldExportSpan("next.render", ["capka.", "ai."])).toBe(false);
    expect(shouldExportSpan("next.render", ["capka.", "ai.", "next."])).toBe(true);
    // Empty list is how "*" is represented once resolved — export everything.
    expect(shouldExportSpan("anything.at.all", [])).toBe(true);
  });

  it("admits operator-supplied attribute keys and prefixes", () => {
    const span = makeSpan("ai.streamText", (s) => {
      s.setAttribute("ai.settings.output", "text");
      s.setAttribute("vendor.thing.one", "1");
      s.setAttribute("still.unknown", "x");
    });

    const clean = sanitizeSpan(span, false, { extraAllowed: ["ai.settings.output", "vendor.thing."] });
    expect(clean.attributes["ai.settings.output"]).toBe("text");
    expect(clean.attributes["vendor.thing.one"]).toBe("1");
    expect(clean.attributes["still.unknown"]).toBeUndefined();
  });

  it("never lets an operator extension override the content gate", () => {
    // Opening a content key by extension must still respect content capture being
    // off — otherwise the extension knob becomes a privacy bypass.
    const span = makeSpan("ai.streamText", (s) => s.setAttribute("ai.prompt.messages", "secret"));

    expect(sanitizeSpan(span, false, { extraAllowed: ["ai.prompt.messages"] }).attributes["ai.prompt.messages"]).toBeUndefined();
  });
});

describe("no duplication of what we already own", () => {
  it("does not export cost by default — the usage ledger is the single money truth", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.setAttribute("capka.cost.usd", 0.0412);
      s.setAttribute("capka.cost.source", "provider");
      s.setAttribute("capka.usage.input_tokens", 4211);
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.attributes["capka.cost.usd"]).toBeUndefined();
    expect(clean.attributes["capka.cost.source"]).toBeUndefined();
    // Token counts DO go out: latency/structure/tokens is what the tracing
    // backend is better at, and they are not a financial figure.
    expect(clean.attributes["capka.usage.input_tokens"]).toBe(4211);
  });

  it("exports cost when an operator deliberately opts in", () => {
    const span = makeSpan("capka.turn", (s) => s.setAttribute("capka.cost.usd", 0.0412));

    const clean = sanitizeSpan(span, false, { includeCost: true });
    expect(clean.attributes["capka.cost.usd"]).toBe(0.0412);
  });
});

describe("vendor correlation keys", () => {
  it("keeps the langfuse session/user/type markers — verified against a live backend", () => {
    // Regression: these were being stripped, so Langfuse showed sessionId: None
    // and could not group a chat's turns. Found only by exporting for real.
    const span = makeSpan("capka.turn", (s) => {
      s.setAttribute("langfuse.session.id", "chat_1");
      s.setAttribute("langfuse.user.id", "user_1");
      s.setAttribute("langfuse.observation.type", "span");
    });

    const clean = sanitizeSpan(span, false);
    expect(clean.attributes["langfuse.session.id"]).toBe("chat_1");
    expect(clean.attributes["langfuse.user.id"]).toBe("user_1");
    expect(clean.attributes["langfuse.observation.type"]).toBe("span");
  });

  it("does not open the whole vendor namespace — its input/output fields carry content", () => {
    const span = makeSpan("capka.turn", (s) => {
      s.setAttribute("langfuse.observation.input", CANARY);
      s.setAttribute("langfuse.observation.output", CANARY);
      s.setAttribute("langfuse.trace.input", CANARY);
    });

    const clean = sanitizeSpan(span, false);
    expect(JSON.stringify(clean)).not.toContain(CANARY);
  });
});
