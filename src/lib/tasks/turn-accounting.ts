import type { MessageMeta } from "@/lib/chat/contracts";

/**
 * The accounting figures one RUN contributed to a turn's message row.
 *
 * Most turns are one run, so these are simply that run's numbers. A turn that
 * suspended on an approval/ask card and was resumed spans TWO runs on the SAME
 * message row (`payload.resumeMessageId` — see runner.ts), and the (i) popover has
 * to show the whole turn rather than only the half after the click.
 */
export interface TurnHalf {
  usage?: MessageMeta["usage"];
  costUsd?: number;
  costSource?: MessageMeta["costSource"];
  durationMs?: number;
  reasoningMs?: number;
  /** Requests the reply took. Summed like the tokens and for the same reason: an
   *  approval continuation asks the provider again, and the popover is answering
   *  "what did this MESSAGE cost", not "what did this run cost". */
  llmCalls?: number;
}

/**
 * Combine the run that just finished with the accounting a suspended earlier half
 * left behind, for the message metadata ONLY.
 *
 * Deliberately not applied to the `usage` ledger or the turn span: both are keyed
 * per RUN (the ledger by `taskId`, the span by its own lifecycle), and the earlier
 * half already has its own row/span there — folding it in a second time would
 * double-count the spend in budgets and org analytics.
 *
 * `contextTokens` is absent here on purpose. It is a snapshot of the LAST call's
 * prompt size, not a running total, so the surviving value must be the later run's;
 * summing it would overstate how full the window is (the same trap `usage.input`
 * carries across a multi-step turn — see contracts.ts).
 */
export function foldTurnHalves(run: TurnHalf, prior: TurnHalf): TurnHalf {
  // No earlier half (the overwhelming majority of turns): hand back the run
  // untouched, so an ordinary turn's metadata is byte-for-byte what it was.
  if (!prior.usage && prior.costUsd == null && prior.durationMs == null && prior.reasoningMs == null && prior.llmCalls == null) return run;

  const usage = run.usage && prior.usage
    ? {
        input: run.usage.input + prior.usage.input,
        output: run.usage.output + prior.usage.output,
        cached: run.usage.cached + prior.usage.cached,
        // Display-only splits, omitted when zero so simple turns stay clean.
        ...sumSplit("cacheWrite", run.usage, prior.usage),
        ...sumSplit("reasoning", run.usage, prior.usage),
      }
    : (run.usage ?? prior.usage);

  // Each half was priced against ITS OWN model — the two can differ, since each run
  // resolves the model afresh — so the halves' costs are added, never recomputed
  // from the combined tokens at one price.
  const costUsd = run.costUsd == null && prior.costUsd == null
    ? undefined
    : (run.costUsd ?? 0) + (prior.costUsd ?? 0);

  return {
    usage,
    costUsd,
    // "provider" claims the figure is the gateway's real billed charge. That only
    // holds if EVERY half reported one; if any half was priced from the catalog, or
    // its cost is missing from the sum entirely, the total is an estimate and the UI
    // must mark it approximate.
    costSource: costUsd == null
      ? undefined
      : run.costSource === "provider" && prior.costSource === "provider"
        ? "provider"
        : "catalog",
    durationMs: sumDefined(run.durationMs, prior.durationMs),
    reasoningMs: sumDefined(run.reasoningMs, prior.reasoningMs),
    llmCalls: sumDefined(run.llmCalls, prior.llmCalls),
  };
}

function sumSplit(
  key: "cacheWrite" | "reasoning",
  a: NonNullable<MessageMeta["usage"]>,
  b: NonNullable<MessageMeta["usage"]>,
): { cacheWrite?: number } | { reasoning?: number } | Record<string, never> {
  const total = (a[key] ?? 0) + (b[key] ?? 0);
  return total > 0 ? { [key]: total } : {};
}

function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  return a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);
}
