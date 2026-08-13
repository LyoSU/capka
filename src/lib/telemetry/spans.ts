/**
 * Span helpers for the agent turn and the work hanging off it.
 *
 * Written against OTel semantic conventions v1.43.0 / the GenAI agent-span
 * conventions as of 2026-08. `gen_ai.*` is still experimental — when the pinned
 * semantic-conventions version moves, this file is the only place to update.
 */
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const TRACER = "capka";

export type TurnStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_approval"
  | "awaiting_answer"
  | "interrupted";

export interface TurnSpanInput {
  taskId: string;
  chatId: string;
  userId: string;
  projectId?: string | null;
  workerId: string;
  channel: "web" | "telegram" | "automation";
  /** Set when this task continues a suspended turn (approval/answer). */
  resumeOf?: string | null;
}

export interface TurnOutcome {
  status: TurnStatus;
  /** Summed across every LLM call in the turn — correct for cost, not for context. */
  usage?: { input: number; output: number; cached?: number; cacheWrite?: number; reasoning?: number };
  /** The LAST call's prompt size. Never a sum — summing counts a cached prefix once per step. */
  contextTokens?: number;
  costUsd?: number;
  costSource?: string;
  keyShared?: boolean;
  steps?: number;
  tools?: number;
  recoveries?: number;
  stalled?: boolean;
  discardedTokens?: number;
  firstTextMs?: number;
  modelFinal?: string;
  modelCount?: number;
  errorCategory?: string;
  /** Exception CLASS name only — never the message (which can quote the request). */
  errorType?: string;
}

/**
 * Turn spans still open, so a shutdown can close them before the exporter is
 * flushed. On globalThis for the same reason the worker's state is (worker.ts):
 * Next dev/HMR re-imports modules, and a second Set would silently lose spans.
 */
const g = globalThis as unknown as { __capkaOpenTurns?: Set<Span> };
const openTurns = (g.__capkaOpenTurns ??= new Set<Span>());

/**
 * What runner.ts reported, and what the turn was started with. Kept until the span
 * closes so the human-facing name and tags can be composed once, from the final
 * facts. Also fixes a subtler bug: without the remembered status, a turn that
 * finished as `cancelled` / `awaiting_approval` was overwritten with "completed"
 * on the clean exit path, losing exactly the non-terminal states we distinguish.
 * Weak so an abandoned span cannot pin memory.
 */
const declaredOutcome = new WeakMap<Span, TurnOutcome>();
const turnInput = new WeakMap<Span, TurnSpanInput>();

function set(span: Span, attrs: Record<string, string | number | boolean | undefined | null>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) span.setAttribute(key, value);
  }
}

/**
 * Ends a turn span exactly once, whoever gets there first. A status reported by
 * runner.ts wins over the caller's default, EXCEPT for `failed`/`interrupted`,
 * which describe how the turn actually ended and therefore override it.
 */
function finishTurn(span: Span, fallback: TurnStatus): void {
  if (!openTurns.delete(span)) return;
  const outcome = declaredOutcome.get(span);
  const input = turnInput.get(span);
  const status =
    fallback === "failed" || fallback === "interrupted" ? fallback : (outcome?.status ?? fallback);
  span.setAttribute("capka.status", status);

  // A listing of a thousand rows all called "capka.turn" is unreadable, and most
  // backends key their filters off tags. Composed here because the model and the
  // outcome are only known now. Nothing here is user content.
  if (input) {
    const model = outcome?.modelFinal;
    span.setAttribute(
      "langfuse.trace.name",
      ["turn", input.channel, model].filter(Boolean).join(" · "),
    );
    span.setAttribute("langfuse.tags", [
      `channel:${input.channel}`,
      `status:${status}`,
      ...(input.projectId ? [`project:${input.projectId}`] : []),
      ...(model ? [`model:${model}`] : []),
      ...(outcome?.errorCategory ? [`error:${outcome.errorCategory}`] : []),
      ...(outcome?.stalled ? ["stalled"] : []),
      ...(outcome?.recoveries ? ["retried"] : []),
    ]);
  }
  // Only a genuine failure is an error. Cancels and the awaiting_* suspends are
  // ordinary outcomes — flagging them would make every approval look like an
  // incident. `message` is deliberately never set: it is free-form provider text.
  span.setStatus({ code: status === "failed" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}

/**
 * Wraps one agent turn. The span is ACTIVE for the duration, so the AI SDK's own
 * `ai.streamText` / `ai.toolCall` spans attach as children without any further
 * plumbing. Called from the worker (the single call site of runAgentTask), which
 * keeps runner.ts free of span lifecycle beyond reporting its outcome.
 */
export function withTurnSpan<T>(input: TurnSpanInput, fn: () => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER);
  return tracer.startActiveSpan(
    "capka.turn",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        // The GenAI convention's own value for invoking an in-process agent.
        "gen_ai.operation.name": "invoke_agent",
        // Langfuse treats any span with `model`/gen_ai.* as a generation; without
        // this the turn root would appear as an extra generation holding the SUM
        // of its children's tokens.
        "langfuse.observation.type": "span",
        "langfuse.session.id": input.chatId,
        "langfuse.user.id": input.userId,
        "capka.task.id": input.taskId,
        "capka.chat.id": input.chatId,
        "capka.user.id": input.userId,
        "capka.worker.id": input.workerId,
        "capka.channel": input.channel,
        ...(input.projectId ? { "capka.project.id": input.projectId } : {}),
        ...(input.resumeOf ? { "capka.resume.of": input.resumeOf } : {}),
      },
    },
    async (span) => {
      openTurns.add(span);
      turnInput.set(span, input);
      // Deep link so a suspicious trace is one click from the conversation it
      // describes. Only when the deployment's public origin is known — guessing
      // one would produce links that 404.
      const origin = (process.env.PUBLIC_URL || process.env.BETTER_AUTH_URL)?.trim().replace(/\/+$/, "");
      if (origin) span.setAttribute("capka.chat.url", `${origin}/chat/${input.chatId}`);
      try {
        const result = await fn();
        finishTurn(span, "completed");
        return result;
      } catch (e) {
        span.setAttribute("error.type", e instanceof Error ? e.name : "unknown");
        finishTurn(span, "failed");
        throw e;
      }
    },
  );
}

/**
 * Records what a turn actually did, on the active turn span. Separate from
 * ending it: runner.ts knows the outcome, the worker owns the lifecycle. A no-op
 * when telemetry is off (the active span is then non-recording).
 */
export function setTurnOutcome(outcome: TurnOutcome): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  declaredOutcome.set(span, outcome);

  const u = outcome.usage;
  set(span, {
    "capka.status": outcome.status,
    "capka.usage.input_tokens": u?.input,
    "capka.usage.output_tokens": u?.output,
    "capka.usage.cached_tokens": u?.cached,
    "capka.usage.cache_write_tokens": u?.cacheWrite,
    "capka.usage.reasoning_tokens": u?.reasoning,
    "capka.context.tokens": outcome.contextTokens,
    "capka.cost.usd": outcome.costUsd,
    "capka.cost.source": outcome.costSource,
    "capka.key.shared": outcome.keyShared,
    "capka.steps": outcome.steps,
    "capka.tools.count": outcome.tools,
    "capka.recoveries": outcome.recoveries,
    "capka.stalled": outcome.stalled,
    "capka.discarded.tokens": outcome.discardedTokens,
    "capka.first_text_ms": outcome.firstTextMs,
    "capka.model.final": outcome.modelFinal,
    "capka.model.count": outcome.modelCount,
    "capka.error.category": outcome.errorCategory,
    "error.type": outcome.errorType,
  });
}

/**
 * Closes every open turn span as interrupted. Called on SIGTERM after the drain
 * window: a BatchSpanProcessor only receives a span in onEnd, so a span still
 * open when the process exits is never exported — and DRAIN_GRACE_MS explicitly
 * tolerates a turn still running. Deliberately does NOT touch the task itself:
 * a turn surviving the drain is reconciled as a retryable "interrupted" by the
 * next instance, and aborting it here would turn a resumable turn into a lost one.
 */
export function endActiveTurnSpans(reason: string): void {
  for (const span of [...openTurns]) {
    span.setAttribute("capka.end_reason", reason);
    finishTurn(span, "interrupted");
  }
}

/**
 * Runs `fn` with NO active span, so anything it starts becomes its own root
 * trace. Required for fire-and-forget aux work (title/memory/compaction), which
 * outlives the turn: as a child it would be a span whose parent ended first,
 * which renders as a corrupt trace.
 */
export function withoutParentContext<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(ROOT_CONTEXT, fn);
}

/**
 * A child span around work the AI SDK cannot see (sandbox HTTP, MCP connect).
 * The callback receives the span so it can add outcome attributes it only learns
 * mid-flight (a status code, a cache hit) — new instrumentation points should not
 * need a new helper.
 */
export function withChildSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER).startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setAttribute("error.type", e instanceof Error ? e.name : "unknown");
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}
