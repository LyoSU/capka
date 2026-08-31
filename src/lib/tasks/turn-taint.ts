/**
 * WHETHER THIS TURN HAS READ ANYTHING IT DID NOT AUTHOR.
 *
 * One boolean per turn, and its consumers treat it as a permission: a turn that has
 * read a tool result, a provider-side search, an attachment, or a summary of any of
 * those may not overwrite a fact the user stated in their own words — the correction
 * is recorded as a conflict instead.
 *
 * WHERE THE PROPERTY LIVES, PRECISELY, because it is NOT here. `messages.untrusted_ingress`
 * is `NOT NULL DEFAULT false`, which is what makes the column implementable against
 * existing history at all — so an unmarked row is CLEAN and `foldAssembledRows` is not a
 * second fail-closed belt. What is left holding the property is `untrustedOutputOf`'s
 * default (unset => untrusted) and the construction sites that call `mark`. A seventh
 * content source added without a mark produces clean rows and breaks nothing else, so the
 * acceptance test in `turn-taint.integration.test.ts` is the only thing that catches it.
 * Do not "restore" a fail-closed predicate below: the column cannot carry one.
 *
 * WHY IT RIDES THE ROW RATHER THAN THE PROCESS, and the precedent is in this repo already.
 * An approval/`ask` continuation is a SECOND TASK with its own `prepareRun`, its own
 * `withEffectLedger` and its own `makeVaultMemoryTools`, writing the SAME message row.
 * None of the construction sites runs for a rehydrated input, so a recomputed flag reads
 * false in half 2 while half 1's retrieved text sits verbatim in the context half 2 is
 * reading — and the split is AGENT-INVOKED, since `ask` is a no-execute tool the model
 * itself calls. Per-turn usage accounting had exactly this shape and got exactly this
 * treatment: see `foldTurnHalves` in `src/lib/tasks/turn-accounting.ts`, which folds two
 * tasks' halves onto one message row for the same reason. Taint is per-TURN and therefore
 * per-MESSAGE; the ledger and the turn span stay per-TASK.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { log } from "@/lib/log";

/** What an undeclared tool's output is. Exported so the sites that consult it, and the
 *  test that pins them, name the same constant instead of restating `true`. */
export const UNTRUSTED_BY_DEFAULT = true;

export type TaintReason = "tool_result" | "provider_tool" | "native_attachment" | "replayed_row";

export type TurnTaint = {
  seen(): boolean;
  /** Monotonic. On the false->true transition ONLY, issues an un-throttled
   *  `UPDATE messages SET untrusted_ingress = true`. Idempotent and lock-free. */
  mark(reason: TaintReason): Promise<void>;
};

/**
 * Flip one message row's mark, un-throttled and outside the snapshot path.
 *
 * OUTSIDE the snapshot throttle on purpose: a snapshot is coalesced and replaces
 * `metadata` wholesale, and the write that must never be lost is the one immediately
 * before a suspend for `ask` — the moment the turn stops and a second task takes over.
 * The `untrusted_ingress = false` clause is what makes a re-driven write a no-op at the
 * database rather than a race: the column only ever goes false -> true.
 */
export const markMessageUntrusted = async (messageId: string): Promise<void> => {
  await db.update(messages)
    .set({ untrustedIngress: true })
    .where(and(eq(messages.id, messageId), eq(messages.untrustedIngress, false)));
};

export function makeTurnTaint(a: {
  messageId: string;
  seeded: boolean;
  /** INJECTED so the unit test needs no database. Production omits it and gets the
   *  `UPDATE` above; the parameter exists because a module that reaches for `db` at
   *  import time cannot be unit-tested at all. */
  write?: (messageId: string) => Promise<void>;
}): TurnTaint {
  let tainted = a.seeded;
  const write = a.write ?? markMessageUntrusted;
  return {
    seen: () => tainted,
    async mark(reason) {
      // A seeded half is already true ON THE ROW — half 1 wrote it — so half 2 marking
      // again would be a statement per step for a value that cannot change.
      if (tainted) return;
      tainted = true;
      log.debug("turn taint", { messageId: a.messageId, reason });
      await write(a.messageId);
    },
  };
}

/**
 * OR over the ENTIRE assembled prompt — every row the model can see right now, replayed
 * history included. It reads the mark STORED AGAINST each row and nothing else: never
 * `role`, never `type`, never any text the row contains. `applyCompaction` splices a
 * summary as `role: "user"`, which is exactly the shape a naive fold would read as
 * `user_authored`; that row's own column is what this reads instead.
 */
export function foldAssembledRows(rows: { untrustedIngress?: boolean | null }[]): boolean {
  return rows.some((r) => r.untrustedIngress === true);
}

/**
 * `untrustedOutput` as DECLARED, defaulting to true. A tool written next year is
 * untrusted until somebody states otherwise, and a tool the runner cannot find in
 * `rawTools` — every provider-executed one — is untrusted because a provider-side fetch
 * is by definition not ours. This is the ONE reader of that declaration.
 *
 * It lives beside the taint rather than inside `runner.ts` for one reason: a predicate
 * only a test can restate is a predicate the test cannot witness a change to, and this
 * is the exception whose silent death (marking every result one layer up) is the defect
 * the single mark site exists to avoid.
 */
export const untrustedOutputOf = (tools: Record<string, unknown>, name: string): boolean =>
  (tools[name] as { untrustedOutput?: boolean } | undefined)?.untrustedOutput !== false;
