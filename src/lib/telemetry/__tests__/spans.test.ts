import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
// NodeTracerProvider (not BasicTracerProvider) because only its register() installs
// the AsyncLocalStorage context manager. Without one, context.active() is always
// root: getActiveSpan() returns undefined and no child span ever attaches — so a
// test on BasicTracerProvider would pass while proving nothing about propagation.
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  withTurnSpan,
  setTurnOutcome,
  endActiveTurnSpans,
  withoutParentContext,
  withChildSpan,
} from "../spans";

let exporter: InMemorySpanExporter;

const TURN = {
  taskId: "task_1",
  chatId: "chat_1",
  userId: "user_1",
  projectId: "proj_1",
  workerId: "worker_1",
  channel: "web" as const,
};

const byName = (name: string): ReadableSpan | undefined =>
  exporter.getFinishedSpans().find((s) => s.name === name);

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
});

afterEach(() => {
  trace.disable();
  context.disable();
});

describe("withTurnSpan — classification", () => {
  it("marks the turn as an agent invocation, not an inference call", async () => {
    await withTurnSpan(TURN, async () => {});

    const turn = byName("capka.turn")!;
    expect(turn.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(turn.kind).toBe(SpanKind.INTERNAL);
    // Langfuse classifies any span carrying `model`/gen_ai.* as a generation; this
    // is its documented escape hatch, so the turn root does not double-count tokens.
    expect(turn.attributes["langfuse.observation.type"]).toBe("span");
  });

  it("carries no gen_ai model or usage attributes on the root", async () => {
    await withTurnSpan(TURN, async () => {
      setTurnOutcome({ status: "completed", usage: { input: 100, output: 20, cached: 80 } });
    });

    const turn = byName("capka.turn")!;
    for (const key of Object.keys(turn.attributes)) {
      expect(key).not.toBe("gen_ai.request.model");
      expect(key.startsWith("gen_ai.usage.")).toBe(false);
    }
    // The aggregate still exists — under our own namespace.
    expect(turn.attributes["capka.usage.input_tokens"]).toBe(100);
  });

  it("maps identity onto both capka.* and the vendor-neutral session keys", async () => {
    await withTurnSpan(TURN, async () => {});

    const turn = byName("capka.turn")!;
    expect(turn.attributes["capka.task.id"]).toBe("task_1");
    expect(turn.attributes["capka.project.id"]).toBe("proj_1");
    expect(turn.attributes["capka.channel"]).toBe("web");
    expect(turn.attributes["langfuse.session.id"]).toBe("chat_1");
    expect(turn.attributes["langfuse.user.id"]).toBe("user_1");
  });
});

describe("withTurnSpan — outcome and status", () => {
  it("marks only a real failure as an error span", async () => {
    await withTurnSpan(TURN, async () => {
      setTurnOutcome({ status: "failed", errorCategory: "provider_rejected", errorType: "APICallError" });
    });

    const turn = byName("capka.turn")!;
    expect(turn.status.code).toBe(SpanStatusCode.ERROR);
    expect(turn.attributes["capka.error.category"]).toBe("provider_rejected");
    expect(turn.attributes["error.type"]).toBe("APICallError");
  });

  it.each(["cancelled", "awaiting_approval", "awaiting_answer", "interrupted"] as const)(
    "treats %s as a normal outcome, not an incident",
    async (status) => {
      await withTurnSpan(TURN, async () => setTurnOutcome({ status }));

      expect(byName("capka.turn")!.status.code).not.toBe(SpanStatusCode.ERROR);
    },
  );

  it("records a thrown error as failed without letting the throw escape unchanged", async () => {
    await expect(
      withTurnSpan(TURN, async () => {
        throw new Error("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");

    const turn = byName("capka.turn")!;
    expect(turn.attributes["capka.status"]).toBe("failed");
    expect(turn.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("context propagation", () => {
  it("makes the turn span active so SDK spans attach as children", async () => {
    await withTurnSpan(TURN, async () => {
      await withChildSpan("ai.streamText", {}, async () => {});
    });

    const turn = byName("capka.turn")!;
    const child = byName("ai.streamText")!;
    expect(child.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(turn.spanContext().traceId);
  });

  it("detaches work that outlives the turn, so aux spans never become orphaned children", async () => {
    await withTurnSpan(TURN, async () => {
      await withoutParentContext(async () => {
        await withChildSpan("ai.generateText", {}, async () => {});
      });
    });

    const aux = byName("ai.generateText")!;
    expect(aux.parentSpanContext).toBeUndefined();
    expect(aux.spanContext().traceId).not.toBe(byName("capka.turn")!.spanContext().traceId);
  });
});

describe("endActiveTurnSpans — shutdown", () => {
  it("closes a still-open turn as interrupted so a restart mid-turn is not a missing trace", async () => {
    // Start a turn and deliberately never let it finish, mirroring a task that
    // outlives DRAIN_GRACE_MS.
    let release: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const running = withTurnSpan(TURN, () => blocked);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    endActiveTurnSpans("shutdown");

    const turn = byName("capka.turn")!;
    expect(turn.attributes["capka.status"]).toBe("interrupted");
    expect(turn.status.code).not.toBe(SpanStatusCode.ERROR);

    release!();
    await running;
    // The turn's own finally must not double-end or duplicate the span.
    expect(exporter.getFinishedSpans().filter((s) => s.name === "capka.turn")).toHaveLength(1);
  });

  it("is a no-op when nothing is running", () => {
    expect(() => endActiveTurnSpans("shutdown")).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("legibility in a backend listing", () => {
  it("names the trace by what it was, not just 'capka.turn'", async () => {
    await withTurnSpan(TURN, async () => {
      setTurnOutcome({ status: "completed", modelFinal: "claude-opus-5" });
    });

    // A thousand identically-named rows are unreadable; this is what the backend
    // shows as the trace title.
    expect(byName("capka.turn")!.attributes["langfuse.trace.name"]).toBe("turn · web · claude-opus-5");
  });

  it("tags the turn so a listing can be filtered without opening rows", async () => {
    await withTurnSpan({ ...TURN, projectId: "proj_1" }, async () => {
      setTurnOutcome({ status: "failed", errorCategory: "rate_limit", modelFinal: "gpt-5" });
    });

    const tags = byName("capka.turn")!.attributes["langfuse.tags"] as string[];
    expect(tags).toContain("channel:web");
    expect(tags).toContain("status:failed");
    expect(tags).toContain("error:rate_limit");
    expect(tags).toContain("project:proj_1");
  });

  it("carries a link back into Capka so a bad trace is one click from its chat", async () => {
    process.env.PUBLIC_URL = "https://capka.example.com";
    try {
      await withTurnSpan(TURN, async () => {});
      expect(byName("capka.turn")!.attributes["capka.chat.url"]).toBe("https://capka.example.com/chat/chat_1");
    } finally {
      delete process.env.PUBLIC_URL;
    }
  });

  it("records the retry/stall markers that explain a slow turn", async () => {
    await withTurnSpan(TURN, async () => {
      setTurnOutcome({ status: "completed", recoveries: 2, stalled: true, steps: 12 });
    });

    const a = byName("capka.turn")!.attributes;
    expect(a["capka.recoveries"]).toBe(2);
    expect(a["capka.stalled"]).toBe(true);
    expect(a["capka.steps"]).toBe(12);
  });
});
