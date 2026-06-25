# Resilient Stream Resume + Correct Token Accounting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a provider stalls or drops mid-stream, continue the answer from where it stopped (provider-agnostic, no prefill) instead of discarding and regenerating; and count tokens/cost correctly on every termination (clean / cancel / abort / stall-out / error).

**Architecture:** On stall or a *transient* stream error, keep `parts`, rebuild the in-progress reply into ModelMessages through the SAME `toUIMessages → sealOrphanToolCalls → convertToModelMessages` pipeline the history uses, append a synthetic `user` "continue" turn, disable reasoning for that stream, and re-stream — appending new deltas to the existing partial (with a one-shot overlap stitch at the seam). Usage is accumulated live from each `finish-step` event instead of the fragile `await result.totalUsage`, so an aborted stream still reports completed-step usage.

**Tech Stack:** TypeScript, Vercel AI SDK 6.0.116, Vitest.

## Why we hand-roll the resume loop (lib check)

AI SDK 6 has **no** mid-stream resume: `maxRetries` re-sends the whole request from scratch (the "start over" behavior we're removing) and never fires on a silent stall; `resumable-stream` is client reconnection, not provider continuation; `continueSteps` was removed after v4. So the loop is ours — but built on lib pieces: `convertToModelMessages` + `sealOrphanToolCalls` (message rebuild + orphan-tool sealing), the `finish-step` event's `usage` (live accounting), and `delay` from `@ai-sdk/provider-utils` (backoff). No new utility modules beyond two small pure functions that earn isolated tests.

## Global Constraints

- Trailing assistant-prefill returns **400** on Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5 — continuation MUST end on a `user` turn.
- Continuation instruction is **English** (model-facing): `"Your previous response was cut off mid-way. Continue from exactly where it stopped — do not repeat any text you already produced, and do not mention the interruption."`
- Recovery budget = **3** per turn (replaces `MAX_STALL_RETRIES = 2`). `MAX_TASK_MS` (`ac`) stays the hard ceiling.
- Cancelled turns now record usage — intended (the provider billed it).
- Continuation/stall keep partial usage in `liveUsage`; only capability/context/empty discards fold it into `discarded` (billing-only).
- No client (`use-background-chat.ts`) / `events.ts` changes — the orphan-seal makes every tool_use paired, and we keep the existing `task:notice {kind:"retrying"}`.

---

### Task 1: Transient-error classifier

**Files:**
- Modify: `src/lib/errors/friendly.ts` (append after `isContextOverflowError`, ~line 158)
- Test: `src/lib/errors/__tests__/transient.test.ts`

**Interfaces:** Consumes existing `classifyLLMError`, `errorText`. Produces `isTransientError(raw: unknown): boolean`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/errors/__tests__/transient.test.ts
import { describe, it, expect } from "vitest";
import { isTransientError } from "@/lib/errors/friendly";

describe("isTransientError", () => {
  it("network drops are transient", () => {
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(new Error("fetch failed: ECONNRESET"))).toBe(true);
  });
  it("5xx / overload / rate-limit are transient", () => {
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("502 Bad Gateway")).toBe(true);
    expect(isTransientError("Error 529: overloaded")).toBe(true);
    expect(isTransientError("429 rate limit exceeded")).toBe(true);
  });
  it("auth / credits / invalid-request are NOT transient", () => {
    expect(isTransientError("401 invalid api key")).toBe(false);
    expect(isTransientError("402 insufficient credits")).toBe(false);
    expect(isTransientError("400 messages must alternate")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run src/lib/errors/__tests__/transient.test.ts` → `isTransientError is not a function`.

- [ ] **Step 3: Implement** (append to `src/lib/errors/friendly.ts`):

```ts
/**
 * A provider hiccup worth re-streaming (continuation), vs. a fatal config/auth
 * error re-streaming can't fix. classifyLLMError has no explicit 5xx rule (they
 * fall to "unknown"), so server-error shapes are matched directly here.
 */
export function isTransientError(raw: unknown): boolean {
  const { category } = classifyLLMError(raw);
  if (category === "network" || category === "rate_limited") return true;
  return /\b(50\d|51\d|52\d|internal server error|bad gateway|service unavailable|temporarily unavailable|server error)\b/i.test(
    errorText(raw),
  );
}
```

- [ ] **Step 4: Run, expect pass.**

- [ ] **Step 5: Commit** — `git commit -am "feat(errors): classify transient provider errors for stream retry"`

---

### Task 2: Resume helpers (`resume.ts`)

**Files:**
- Create: `src/lib/tasks/resume.ts`
- Test: `src/lib/tasks/__tests__/resume.test.ts`

**Interfaces:** Produces `buildResumeMessages(msgId, parts): Promise<ModelMessage[]>` and `stitchOverlap(tail, delta): string`. (Backoff uses `delay` from `@ai-sdk/provider-utils` directly in the runner — no wrapper. Recovery budget is a runner-local const.)

- [ ] **Step 1: Failing test**

```ts
// src/lib/tasks/__tests__/resume.test.ts
import { describe, it, expect } from "vitest";
import { stitchOverlap, buildResumeMessages } from "@/lib/tasks/resume";

describe("stitchOverlap", () => {
  it("drops a verbatim repeated overlap", () => {
    expect(stitchOverlap("…the quick brown fox", " fox jumps")).toBe(" jumps");
    expect(stitchOverlap("hello world", "world peace")).toBe(" peace");
  });
  it("no overlap → delta unchanged", () => {
    expect(stitchOverlap("abc", "xyz")).toBe("xyz");
  });
  it("full overlap / empty inputs", () => {
    expect(stitchOverlap("done.", "done.")).toBe("");
    expect(stitchOverlap("", "next")).toBe("next");
    expect(stitchOverlap("prev", "")).toBe("");
  });
});

describe("buildResumeMessages", () => {
  it("[] when nothing replayable (empty / reasoning-only)", async () => {
    expect(await buildResumeMessages("m1", [])).toEqual([]);
    expect(await buildResumeMessages("m1", [{ type: "reasoning", text: "hmm" }] as never)).toEqual([]);
  });
  it("text-only partial ends on a user 'continue' turn (never a prefill)", async () => {
    const msgs = await buildResumeMessages("m1", [{ type: "text", text: "Step one is to" }] as never);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs.at(-1)!.role).toBe("user");
  });
  it("dangling tool-call is sealed into a paired result, ends on user turn", async () => {
    const msgs = await buildResumeMessages("m1", [
      { type: "text", text: "Let me check." },
      { type: "tool-call", id: "t1", name: "read_file", input: { path: "a.ts" } },
    ] as never);
    expect(msgs.some((m) => m.role === "tool")).toBe(true); // convertToModelMessages accepted it
    expect(msgs.at(-1)!.role).toBe("user");
  });
  it("completed tool step is replayed before the continue turn", async () => {
    const msgs = await buildResumeMessages("m1", [
      { type: "text", text: "Reading config." },
      { type: "tool-call", id: "t1", name: "read_file", input: { path: "cfg.json" } },
      { type: "tool-result", id: "t1", name: "read_file", output: { ok: true } },
      { type: "text", text: "The config enables" },
    ] as never);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(msgs.at(-1)!.role).toBe("user");
  });
});
```

- [ ] **Step 2: Run, expect fail** (module missing).

- [ ] **Step 3: Implement** `src/lib/tasks/resume.ts`:

```ts
import { convertToModelMessages, type ModelMessage } from "ai";
import { toUIMessages } from "@/lib/chat/presenter";
import { sealOrphanToolCalls } from "@/lib/chat/tool-results";
import type { StoredPart } from "@/lib/chat/contracts";

// English — instruction for the model, not the user.
const CONTINUE =
  "Your previous response was cut off mid-way. Continue from exactly where it stopped — do not repeat any text you already produced, and do not mention the interruption.";

/**
 * A continuation re-stream is a fresh assistant turn, so the model may re-emit
 * the last few words. Strip the longest prefix of `delta` that is already a
 * suffix of `tail`. Applied once, to the first text delta after a resume.
 */
export function stitchOverlap(tail: string, delta: string): string {
  for (let n = Math.min(tail.length, delta.length); n > 0; n--) {
    if (tail.endsWith(delta.slice(0, n))) return delta.slice(n);
  }
  return delta;
}

/**
 * Rebuild the in-progress reply to RESUME it, ending on a `user` "continue" turn
 * (never an assistant prefill — that 400s on modern Anthropic models). Reuses the
 * history pipeline so tool-result shapes match and a dangling tool-call is sealed
 * into a terminal pair (no unpaired tool_use). Reasoning is dropped — partial
 * thinking isn't replayable, and the caller disables reasoning on the re-stream.
 * Returns [] when there's nothing to resume from (caller restarts clean).
 */
export async function buildResumeMessages(msgId: string, parts: StoredPart[]): Promise<ModelMessage[]> {
  const replayable = parts.filter((p) => p.type !== "reasoning");
  if (replayable.length === 0) return [];
  // status omitted (≠ "running") so toUIMessages seals a dangling call as output-error.
  const ui = sealOrphanToolCalls(
    toUIMessages([{ id: msgId, role: "assistant", content: "", metadata: { parts: replayable }, createdAt: null, platform: null }]),
  );
  const assistantMsgs = await convertToModelMessages(ui);
  if (assistantMsgs.length === 0) return [];
  return [...assistantMsgs, { role: "user", content: CONTINUE }];
}
```

> If `StoredPart` isn't exported from `@/lib/chat/contracts`, use the type that file exposes for `MessageMeta["parts"]`.

- [ ] **Step 4: Run, expect pass.** If the dangling-tool case throws `AI_MissingToolResultsError`, the seal didn't apply — confirm `status` is omitted on the synthetic row.

- [ ] **Step 5: Commit** — `git add src/lib/tasks/resume.ts src/lib/tasks/__tests__/resume.test.ts && git commit -m "feat(tasks): resume helpers — continuation messages + seam stitch"`

---

### Task 3: Live per-step token accounting

**Files:** Modify `src/lib/tasks/runner.ts` — usage type import; accumulators replacing `discarded`/`captureDiscarded`; accumulate at `finish-step`; fold on discards; finalize from `liveUsage`.

**Interfaces:** Consumes AI SDK `LanguageModelUsage`. Produces `liveUsage`/`discarded`/`hadDiscard` + `foldDiscarded()` used by Task 4.

- [ ] **Step 1: Import the usage type** — extend the `import type … from "ai"` (line 2):

```ts
import type { ModelMessage, UserModelMessage, TextPart, ImagePart, FilePart, LanguageModelUsage } from "ai";
```

- [ ] **Step 2: Replace the `discarded`/`captureDiscarded` block (~lines 628-646)** with:

```ts
    // Usage accumulated LIVE from finish-step events — the source of truth.
    // `result.totalUsage` rejects on an aborted stream, so relying on it dropped
    // usage (and skipped billing) on every cancel/break. Per-step usages sum to
    // totalUsage on a clean run and survive an abort (steps emit usage before the
    // `abort` event).
    const liveUsage = { input: 0, output: 0, cached: 0 };
    // Spend on attempts thrown away by a capability/context/empty discard — billed
    // by the provider, but excluded from the (i) popover (which shows the final answer).
    const discarded = { input: 0, output: 0, cached: 0 };
    let hadDiscard = false;
    // Roll the current visible-answer usage into `discarded` when a retry wipes
    // `parts`. Stall/transient resumes KEEP their output, so they don't fold.
    const foldDiscarded = () => {
      if (liveUsage.input || liveUsage.output || liveUsage.cached) hadDiscard = true;
      discarded.input += liveUsage.input; discarded.output += liveUsage.output; discarded.cached += liveUsage.cached;
      liveUsage.input = 0; liveUsage.output = 0; liveUsage.cached = 0;
    };
```

- [ ] **Step 3: Accumulate at `case "finish-step"`** (~line 847) — add as the first lines (inline, single call site):

```ts
          case "finish-step": {
            const u = event.usage as LanguageModelUsage;
            const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
            liveUsage.input += u.inputTokenDetails?.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cached);
            liveUsage.output += u.outputTokens ?? 0;
            liveUsage.cached += cached;
            await flushBuffers();
            await saveSnapshot(true);
            await heartbeat(taskId, workerId);
            break;
          }
```

- [ ] **Step 4: Replace `await captureDiscarded();` → `foldDiscarded();`** in `retryOnCapabilityError` (both branches) and `retryOnContextOverflow`. These run after `discardPartial()`, banking the wiped attempt's usage before the next attempt accumulates.

- [ ] **Step 5: Replace the finalize usage block (~lines 1005-1019)** with:

```ts
    // Usage from the live accumulator (robust to cancel/abort), not result.totalUsage.
    const usageMeta = liveUsage.input || liveUsage.output || liveUsage.cached
      ? { input: liveUsage.input, output: liveUsage.output, cached: liveUsage.cached }
      : undefined;
    let costMeta: number | null = null;
    if (usageMeta) {
      try {
        costMeta = await costUsd(modelId, { inputTokens: usageMeta.input, outputTokens: usageMeta.output, cachedInputTokens: usageMeta.cached });
      } catch (e) { tlog.error("cost compute failed", { err: String(e) }); }
    }
```

(`recordUsage` at ~1095 already reads `usageMeta.* + discarded.*` and `hadDiscard` — unchanged.)

- [ ] **Step 6: Typecheck + tests** — `npx tsc --noEmit && npx vitest run src/lib/tasks` → clean.

- [ ] **Step 7: Commit** — `git commit -am "fix(tasks): account tokens from live per-step usage (correct on cancel/abort)"`

---

### Task 4: Resume-by-continuation orchestration

**Files:** Modify `src/lib/tasks/runner.ts` — imports; `resumeMessages` in `makeStream`; resume state + `resume()`; stitch in `text-delta`; reset in `discardPartial`; replace stall loop with the unified recovery loop; drop `MAX_STALL_RETRIES`/`stallRetries`.

**Interfaces:** Consumes `buildResumeMessages`, `stitchOverlap` (Task 2), `isTransientError` (Task 1), `delay` (`@ai-sdk/provider-utils`), `foldDiscarded` (Task 3).

- [ ] **Step 1: Imports** — add near the other imports:

```ts
import { delay } from "@ai-sdk/provider-utils";
import { isTransientError } from "@/lib/errors/friendly";
import { buildResumeMessages, stitchOverlap } from "@/lib/tasks/resume";
```

- [ ] **Step 2: Replace the `MAX_STALL_RETRIES` const (~line 153)** with:

```ts
/** Max recovery attempts (stall + transient) per turn before giving up. */
const MAX_RECOVERIES = 3;
```

- [ ] **Step 3: `resumeMessages` in `makeStream`** — declare `let resumeMessages: ModelMessage[] = [];` just before `const makeStream = () => {` (~line 605), and change the `messages:` line (~line 619):

```ts
        messages: [...systemMessages, ...modelMessages, ...resumeMessages],
```

- [ ] **Step 4: Resume state** — replace `let stallRetries = 0;` (~line 598) with:

```ts
    let recoveries = 0;
    let stitchNextDelta = false; // one-shot seam fix on the first delta after a resume
    let resumeTail = "";
```

Update the watchdog log (~line 601) `attempt: stallRetries` → `attempt: recoveries`.

- [ ] **Step 5: Reset resume state in `discardPartial`** (the clean-restart path) — add inside it:

```ts
      resumeMessages = [];
      stitchNextDelta = false;
```

- [ ] **Step 6: Stitch in `case "text-delta"`** (~lines 768-775) — replace with:

```ts
          case "text-delta": {
            let text = event.text;
            if (stitchNextDelta) { stitchNextDelta = false; text = stitchOverlap(resumeTail, text); }
            if (!text) break;
            if (firstTextAt == null) firstTextAt = Date.now();
            currentStatus = undefined;
            appendText(text);
            textBuf += text;
            scheduleFlush();
            break;
          }
```

- [ ] **Step 7: `resume()` closure** — add just before the recovery loop (`for (;;) {`, ~line 944):

```ts
    // Continuation: KEEP parts, rebuild into a user-turn "continue" request (never
    // an assistant prefill — 400s on modern Anthropic), disable reasoning, arm the
    // seam stitch, re-stream. false → nothing to resume from (caller restarts clean).
    const resume = async (): Promise<boolean> => {
      await flushBuffers();
      const msgs = await buildResumeMessages(msgId, parts);
      if (msgs.length === 0) return false;
      resumeTail = getFullText().slice(-500);
      stitchNextDelta = true;
      useReasoning = false;
      resumeMessages = msgs;
      result = makeStream();
      return true;
    };
```

- [ ] **Step 8: Replace the stall loop (~lines 944-972)** with the unified recovery loop:

```ts
    for (;;) {
      stalled = false;
      let transient: unknown;
      try {
        await consume();
        if (streamError && !ac.signal.aborted) {
          if (!(await retryOnCapabilityError(streamError)) && !(await retryOnContextOverflow(streamError))) {
            if (isTransientError(streamError)) transient = streamError;
          }
        }
      } catch (e) {
        if (!(await retryOnCapabilityError(e)) && !(await retryOnContextOverflow(e))) {
          if (isTransientError(e)) transient = e;
          else throw e;
        }
      }

      if (ac.signal.aborted) break;
      if (!stalled && transient === undefined) break;
      if (recoveries >= MAX_RECOVERIES) { stalledOut = true; break; }
      recoveries++;

      // Transient errors back off; a stall retries at once (it already waited 60s).
      if (transient !== undefined) {
        streamError = undefined; // a successful resume must not finalize as failure
        await delay(1000);
        if (ac.signal.aborted) break;
      }

      await publishTaskEvent(userId, {
        type: "task:notice", taskId, chatId, messageId: msgId,
        notice: { kind: "retrying", attempt: recoveries, max: MAX_RECOVERIES },
      });

      attemptAc = new AbortController(); // fresh signal; the stalled one stays aborted
      if (!(await resume())) { await discardPartial(); foldDiscarded(); result = makeStream(); }
    }
```

- [ ] **Step 9: Keep-partial-on-failure (verify only).** The finalize `db.update` persists `getFullText()` + `parts` regardless of status, and `parts` now holds the partial on stall-out — so the partial rides through under `PROVIDER_UNRESPONSIVE_ERROR`. Read the block (~1035) to confirm `parts: parts.length > 0 ? parts : undefined` and no code change is needed.

- [ ] **Step 10: Confirm no stale refs** — `grep -n "stallRetries\|MAX_STALL_RETRIES\|captureDiscarded" src/lib/tasks/runner.ts` → no matches.

- [ ] **Step 11: Typecheck + tests** — `npx tsc --noEmit && npx vitest run src/lib/tasks src/lib/errors` → clean.

- [ ] **Step 12: Commit** — `git commit -am "feat(tasks): resume stalled/transient streams by continuation instead of restart"`

---

### Task 5: Manual verification

**Files:** none (manual). Restart the platform container first — the in-process worker loop does NOT hot-reload.

- [ ] **Stall** — slow/unstable model, long prompt. After ~60s: "model is slow, retrying…" then the answer **continues** (not re-typed); no wipe.
- [ ] **Cancel mid-stream** — stop a long answer. Message keeps the partial; (i) popover shows non-zero tokens/cost; usage table records the turn (was 0).
- [ ] **Tool-cycle stall** — stall after a tool result. Resume continues after the result; the tool isn't re-run.
- [ ] **Exhaust retries** — keep silent past 3 recoveries. Turn ends failed but KEEPS the partial + "model stopped responding".

---

## Self-Review

**Spec coverage:** A resume-by-continuation → Tasks 2,4. A provider-correctness (no prefill, user-turn, orphan seal, reasoning dropped) → Task 2 (tested). B transient + backoff + unified budget → Tasks 1,4. C keep partial → Task 4 Step 9. D live usage / cancel billing → Task 3. Seam stitch → Task 2 + Task 4 Step 6. No client/events changes → Global Constraints, verified by Task 2's dangling-tool case. ✓

**Placeholder scan:** none — every code step is complete; the only conditional is the `StoredPart` import note (names the file to check). ✓

**Type consistency:** `liveUsage`/`discarded`/`foldDiscarded` (Task 3) → used Task 4; `resumeMessages`/`resume`/`stitchNextDelta`/`resumeTail`/`MAX_RECOVERIES` defined+used in Task 4; `buildResumeMessages`/`stitchOverlap` (Task 2) → Task 4; `isTransientError` (Task 1) → Task 4; `delay` from `@ai-sdk/provider-utils`. ✓

**Minimalism check:** two pure functions only (both earn isolated tests); backoff uses lib `delay` (no wrapper); `MAX_RECOVERIES` is one runner const (no config/array); per-step usage inlined at its single call site; one test file for resume; zero client/event-contract changes. ✓
