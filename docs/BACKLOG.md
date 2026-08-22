# Backlog — context management, and what v0.30.0 left open

Written 2026-08-22 right after v0.30.0; **revised the same day** after every claim
was checked against the live provider docs, the installed SDKs, and the code, plus
an independent review pass. Items that turned out to be false or not worth doing
are kept below with the evidence, so they are not rediscovered.

Effort scale: **XS** under an hour · **S** a few hours · **M** half a day to a
day · **L** multi-day, needs a design decision first.

Status markers: **DONE** shipped in this pass · **DROPPED** with reason ·
**FALSE** claim did not survive verification.

---

## A. Provider-native context management we are not using

### A1 · Server-side compaction (`compact_20260112`) — **L**

Verified against the docs: beta `compact-2026-01-12`, trigger default 150k input
tokens and **minimum 50k** (the original note called the minimum the default),
`pause_after_compaction`, `instructions`. Anthropic states server-side compaction
is the recommended strategy. Supported on every model we would plausibly run.

The installed SDK carries this end to end — it parses the `compaction` content
block, streams `compaction_delta`, forwards `trigger`/`pauseAfterCompaction`/
`instructions` by name, and round-trips the block back out of a text part's
provider metadata. So the "hard part" the first draft worried about — correct
token accounting across the summary — is **already handled**:
`convertAnthropicMessagesUsage` sums the `compaction` and `message` iterations
into `inputTokens`.

**That is also the one landmine.** Because the SDK sums the iterations, a
compaction step reports input as summary-pass + answer-pass combined. We read
`lastStepContextTokens = event.usage.inputTokens ?? 0` (`runner.ts`), and that
figure feeds three things that must NOT see a sum: the context-window meter, our
own compaction trigger, and `armPruneBoundary`. Adopting A1 without splitting
them means the meter spikes, our compactor fires immediately after the server's,
and the brake arms off a number that describes no prompt that ever existed.
`CLAUDE.md` already forbids conflating `usage` with `contextTokens`; here the SDK
conflates them for us, so `contextTokens` has to come from the last `message`
iteration specifically.

**Design decision, settled:** adopt **narrowly**, as the Anthropic implementation
of the existing *post-turn* checkpoint job, with `pauseAfterCompaction: true` —
never inside the per-step agent loop. Reason: Anthropic marks the summary on
`text-start`, and the runner ignores `text-start` provider metadata and stores the
deltas that follow as ordinary visible text; in-loop compaction could also land
mid-message, which `summarizedUpTo: messageId` cannot express. The marker records
`{ source, summary, summarizedUpTo, serverBlock }` so Anthropic can be handed its
own block back while a provider switch falls back to `summary` as our ordinary
cross-provider recap. Do not write `tokensSaved` unless before/after usage
actually measures it.

Worth doing before B1/C3 only in the sense that it changes what a restarted turn
must carry — not before B1 itself, which is a correctness bug.

### A2 · Thinking-block clearing (`clear_thinking_20251015`) — **DONE**

The docs confirm the premise: Opus 4.5+ and Sonnet 4.6+ keep **all** prior
thinking by default. They also confirm the ordering rule — when strategies are
combined, `clear_thinking_20251015` must be listed first in `edits`.

Two things the first draft missed, and together they change the shape of the work:

1. **The strategy has no `trigger`.** Unlike `clear_tool_uses_20250919` it takes
   only `keep`, so it applies on **every** request. And per the docs, "when
   thinking blocks are cleared, the cache is invalidated at the point where
   clearing occurs". In a long tool loop every step adds a thinking block, so a
   small `keep` walks the clearing point forward every step and pays a cache
   transition every step. Adding it "alongside the existing edit" would cost more
   than it saves.
2. **We have no fixed default model.** Connections choose arbitrary model IDs, so
   "those are our models" holds only for whatever an admin picked.

Done that way: the edit is attached only once `contextIsDeep` says the live segment
has crossed the tool-clearing trigger, and it is listed FIRST in `edits` as the docs
require. `contextIsDeep` had to be split out of `shouldClearToolResults`, which
answers "should WE clear" and therefore returns false for Anthropic by design — so
asking it about depth on Anthropic always said no. The decision is persisted as
`contextDeep` for the same reason the tool decision is: shedding shrinks the next
measurement, so a fresh answer each turn would oscillate.

`keep` is `THINKING_KEEP_TURNS`, equal to `TOOL_CLEAR_KEEP_LAST`, so "recent" means
one thing across both edits.

**Stated honestly: the win is unmeasured.** Clearing thinking invalidates the cache
from the clearing point, and inside a tool loop the cleared set changes every step,
so the cache cannot settle. The gate confines that cost to the regime where the
alternative is not a bigger bill but a turn that does not fit. If measurement shows
it negative, the fix is to stop attaching the edit — not to widen `keep`.

### A3 · `exclude_tools` on the tool-clearing edit — **DROPPED**

Two independent reasons.

The invariant: `provider-edits.ts` states the clearing policy is kept shared "so
the behaviour can't fork by provider", and `clearStaleToolResults(messages,
keepLast)` — the client-side half every non-Anthropic provider runs — has **no
name-based exclusion at all**. Adding `exclude_tools` to the Anthropic edit alone
forks exactly what that comment forbids; doing it properly means threading an
exclusion list through the client-side path too, which is not XS.

The value: exempting memory and skill reads permanently retains the *largest*
bodies, which is the mechanism the relief exists to shed. That trade might win,
but it is an unmeasured hypothesis. Reconsider only with traces showing repeated
re-reads cost more than retaining those bodies forever.

### A4 · `clearAtLeast` — **DOWNGRADED to measurement only**

The values are as described: trigger `min(50% of window, 120k)`, `keep: 3`,
`clearAtLeast: 1000`. But "a floor that almost never binds" did not survive:
a 121k prompt made of 80k non-tool tokens, 40.8k in the three protected newest
tool uses, and one older eligible 200-token tool use crosses the trigger with
only 200 tokens clearable — the floor is decisive there, and correctly so.

Break-even arithmetic argues the other way for the common shape: clearing moves
the suffix from cache-read (0.1×) to cache-write (1.25×) once, and saves 0.1× ×
shed per later step, so it pays off after roughly `11.5 × suffix/shed` steps —
which for a 1000-token shed is never. Both facts are true, and they pull in
opposite directions **because the suffix size is the term we do not measure**.

Therefore: do not swap 1000 for an invented fraction. Measure the distribution of
eligible-clear sizes first; the number should follow evidence, not a formula
applied to an unmeasured variable.

### A5 · Cache breakpoints on OpenAI — **comment DONE, code DROPPED**

Verified: GPT-5.6+ does expose explicit `prompt_cache_breakpoint` and
`prompt_cache_options.ttl` (30 minutes, the only value), with a strict 1,024-token
minimum. The first draft also had the file wrong — the comment lives in
`runner.ts` (twice), not `provider-edits.ts`.

More importantly the comment was **incomplete, not false**: other providers really
do ignore the Anthropic namespace, because the marker we place contains only
`anthropic.cacheControl`. And the code change it implied is unnecessary — OpenAI's
implicit default already places a breakpoint on the latest user **or tool**
message, which is precisely the moving step-tail we hand-roll for Anthropic. There
is nothing to add there.

Comment corrected in this pass so the next reader doesn't reason from the gap.

Gemini, unchanged and no action: implicit caching on by default for 2.5+, minimum
2,048 tokens (4,096 on 3.5/3.6/3.7), no explicit `CachedContent` in the
Interactions API. Our "common prefix first" layout is already what it wants.

---

## B. Open defects from the v0.30.0 review

### B1 · Effects dropped from `parts` are not persisted — **DONE**

An independent review of the first cut found four blockers, all fixed before this
was called done — worth recording because three of them were *worse* than the bug
being fixed, and two were pre-existing:

1. **A malformed call was ledgered as executed.** The SDK synthesizes a
   `tool-error` for an unparseable call or an unknown tool **without invoking
   execute**, so the note would say "already ran, do not repeat" about work that
   never happened. Duplication is bad; omission is worse. Pre-existing since
   v0.30.0 in the in-memory ledger — the durable table only made it durable. Fixed
   by tracking `invalid` from the `tool-call` event and skipping those ids.
2. **Raw `input` into jsonb.** The runner strips NUL for `parts` precisely because
   Postgres rejects it; the ledger wrote `event.input` unsanitized, so a valid JSON
   argument containing `\u0000` could execute and then fail to be recorded. Fixed
   inside `recordEffect`, not at the call sites — one place cannot be forgotten in
   the next one.
3. **Either/or instead of a union.** The first cut used `parts` only when the
   ledger was empty. But an empty ledger is also what a failed write leaves, and a
   rolling upgrade can leave one message with its first half in `parts` and its
   second in the table — so a second suspension would drop the older half. Fixed
   with `mergeEffects`, unioned by tool-call id, ledger winning.
4. **A lost write did not fail closed.** A Postgres blip classifies as `network`,
   which `isTransientError` calls transient — so the stream loop would re-stream
   and continue with the call unrecorded. Fixed with a bounded retry plus a typed
   `EffectLedgerError` the runner checks *before* its transient branch.

Also fixed: the upsert overwrote `failed: true` with `false` when the same id later
succeeded, erasing the one entry the note most needs to flag. `failed` is now
sticky (`existing or excluded`).

Residual gaps, stated rather than implied:

- **Execution-to-ledger window.** A tool starts before its result event arrives, so
  a crash or abort in between still loses the record. Only tool-level idempotency
  keys or a transactional outbox close this.
- **`effectsFromParts` cannot see `invalid`.** A pre-upgrade message's parts can
  therefore still contribute a false "already ran". Bounded to messages that
  predate the table, and it disappears as those age out.
- **No per-statement timeout on the ledger write.** The turn deadline and the stall
  watchdog bound it, but not tightly.
- **The tests pin the module, not the wiring.** They would still pass if the
  runner's `recordEffect` calls were deleted; the runner has no test file of its
  own, which is a known hole (see B3).


Confirmed: executed effects survive an in-process `discardPartial` only in the
in-memory `turnEffects`, while `parts` is cleared; finalization persists only the
surviving `parts`, and a continuation rebuilds the ledger exclusively from those.
An effect an earlier restart removed is therefore irrecoverable, and can be
missing from a later recovery note — so a non-idempotent write can run twice.

**Design decision, settled:** the ledger's lifetime is the logical assistant
message, not either task — an approval/ask continuation is a second task reusing
the same `msgId`. So it belongs neither in the per-task usage ledger or span, nor
in `messages.metadata`, because snapshots and finalization replace that blob
wholesale. Use an append-only `message_effects` table keyed `(message_id,
tool_call_id)`, FK to `messages.id ON DELETE CASCADE`, carrying
`producer_task_id` (provenance, not ownership), `tool_name`, `input`, `failed`,
`created_at`. Write on `tool-result`/`tool-error`, load by `msgId` on every
initial/resume/restart path, and render recovery notes from it rather than from
`parts`.

This closes the dropped-from-`parts` hole. It does **not** give exactly-once
across a crash between an external side effect and the ledger insert — that needs
tool-level idempotency keys or a transactional outbox, and should be stated as
such rather than implied.

### B2 · The brake cannot arm without per-step usage — **DONE**

Confirmed. A `stream_options` rejection disables the field and re-streams;
`lastStepContextTokens` is then `event.usage.inputTokens ?? 0`, and zero never
crosses a positive trigger — on exactly the OpenAI-compatible endpoints that also
have no server-side edit.

No tokenizer needed: `prepareStep` already receives the exact prompt array, so a
conservative serialized-character estimate over it is enough, and the codebase
already estimates this way in two places. The per-result byte count we compute is
cheaper but insufficient — it omits system, history, tool inputs, and assistant
text. Use the estimate **only** to arm the brake, never for `contextTokens`, so
the (i) popover keeps reporting one honest measured figure.

Note the inverse, which nobody wrote down: where usage *is* reported the brake is
live — so OpenRouter, which reports it, is the first provider where this code path
meets real traffic.

### B3 · The `view_file` bridge shifted the cut by one — **DONE**

Arithmetic confirmed: with `base.length = B`, one bridge makes `msgs.length =
B+1`, so the boundary armed at `B-2` instead of `B-3`. Bounded to exactly one
message and non-compounding, because both the actual and intended recurrences are
`max(previous, candidate)` and `armPruneBoundary` is genuinely nondecreasing.
Monotonic only *within* one `streamText` — `makeStream` resets the boundary by
design.

Fixed by measuring `base.length`. Pruning still runs on `msgs`, and that
difference is load-bearing: it keeps the injection itself outside the shed zone.

Still the **third** instance of one class: an absolute index into a list somebody
else rebuilds (first the emergency trim, then all ten `makeStream()` sites, now
what `prepareStep` appends before we measure). The open one of the same shape:
`armPruneBoundary`'s two inputs come from different moments — `messageCount` is
this step, `lastStepContextTokens` the previous one. Probably fine, since a
boundary needs to be a place and not a size, but it is the same mismatch.

### B4 · Crashed worker restarting onto a fresh row — **FALSE**

A crashed `running` task is never re-claimed: `claimNextTask` selects only
`WHERE t.status = 'queued'`, and `reconcileZombies` moves expired `running` rows
permanently to `failed`. A later user retry is a new task and a new turn, not a
reclaimed worker run — so there is no restart-onto-a-fresh-row path to design for.
No work.

### B5 · No per-turn ceiling on total tool output — **DONE**

`MAX_TURN_TOOL_OUTPUT_CHARS` now bounds the sum.

**The first implementation was the wrong layer, and review found four separate bugs
in it** — worth recording, because all four came from that one choice. It wrapped
every tool's `execute`: that broke tools returning an async iterable (the SDK
inspects the IMMEDIATE return value, and an `async` wrapper hands it a promise); it
could not reserve budget safely when the SDK runs a batch of calls concurrently; its
plain-string refusal went through each tool's own `toModelOutput` and came out of the
MCP converter as an empty result the model never saw; and the refusal was then
recorded in the effect ledger as a call that RAN.

Enforced by **stopping** instead: `prepareStep` sets `toolChoice: "none"` once the
turn's results add up past the ceiling — the same lever `FORCE_TEXT_AFTER_STEPS` and
the wall-clock wrap-up already use. Nothing is refused, nothing is rewritten, and
parallel calls cannot race a counter that is only read between steps.

Known limit: the counter is per TASK, so an approval or `ask` continuation starts
with a fresh budget. This is a safety net, not an accounting guarantee; making it
survive suspension means persisting the tally the way `usage` is, which is worth
doing only if a real turn is seen to exploit the reset.

---

## C. Infrastructure

### C1 · `testTimeout` — **DONE**

Set globally in `vitest.config.ts`; the integration config `mergeConfig`s it, so
one line covers both suites (the first draft implied two fixes).

The first draft's *mechanism* was wrong and the corrected one matters, because it
changes what a per-file fix would have achieved. Measured on a full run:
`sandbox-entrypoint.test.js` failed one test at 8,264 ms while **passing** another
at 11,837 ms in the same file, with no assertion diff. That is impossible under a
uniform 5,000 ms budget — and the file sets no per-test timeouts. The cause is
that its bodies drive the egress firewall through `spawnSync` and therefore
**block**: the timeout timer cannot preempt a running child, so whether it fires
is a race with the event loop regaining control. Not import cost — that file
imports in 183 ms and spends 16.4 s in test bodies.

Verified after the change: the file passes, 11 tests.

### C2 · `MAX_AGENT_STEPS` was not settable under Compose — **DONE**

Runtime reads it (`MAX_STEPS = Number(process.env.MAX_AGENT_STEPS) || 25`), but it
was absent from both `docker-compose.yml` and `.env.example`, and there is no
`env_file`, so nothing arrived implicitly. Added to both — the `.env.example` half
is what brings it under `deploy-contract.test.ts`, which can only see knobs
documented there. `FORCE_TEXT_AFTER_STEPS` went inert precisely because it was
documented in the CHANGELOG instead.

### C3 · Durable manifest on forced termination — **DOWNGRADED**

Confirmed as described: shutdown waits, closes spans, and exits without
persisting unfinished-turn state; the next instance only reconciles expired tasks
to failed. But with B4 false, this no longer has a sibling — and the current
behaviour fails *honestly* rather than duplicating work. Treat it as design
research gated on observed forced-interruption frequency, not an infrastructure
project.

---

## D. Defects found while verifying the above

### D1 · Mid-turn keep policy sheds about twice what it declares — **DONE**

`TOOL_CLEAR_KEEP_LAST = 3` is documented as "how many of the most recent tool
results keep their bodies", and the brake passes that number to the SDK pruner as
a count of trailing **messages** (`before-last-N-messages`). The SDK counts
messages, not calls, and a tool loop appends roughly one assistant + one tool
message per exchange — so at the moment it arms, the brake keeps about one and a
half exchanges where the shared policy says three. The mechanism is documented in
`step-control.ts`; the *value* is what crosses the unit boundary unconverted.

Fix this before tuning any threshold: right now the mid-turn cut is more
destructive than the policy every other path enforces.

### D2 · `errorOwned` is lost on reload — **DONE**

The runner persists `errorOwned` (two sites) and the message component reads it,
but `MessageMeta` never declares it and the presenter forwards only the other
three error fields. So own-key error-detail ownership silently disappears after a
history reload. Fold into the next metadata-contract change.

### D3 · A missing continuation row finalizes as success — **DONE**

A missing continuation message is treated as empty metadata with
`messageInserted = true`, and finalization's message `UPDATE` never inspects its
row count before committing the task as completed. A message deleted between
enqueue and execution therefore yields a terminal successful task with no reply
row. Low frequency, but finalization should not report ownership after updating
zero rows.

### D4 · A fatal stream failure was under-logged — **DONE (claim corrected)**

**The original claim was wrong**, and review caught it: `tlog.warn("task finished")`
already carries the model, tool count, duration and the raw `streamError`. What was
missing was not the trace but its SHAPE — nothing said how deep the turn was when the
error arrived. Fixed by adding prompt size, message count, recovery count and total
tool output to that same record, rather than emitting a second one. The turn span carries
`errorCategory`, `steps`, `recoveries`, and the model, and deliberately does not
carry the provider's free-form text (correctly — it is a content gate). The
consequence is that for `errorCategory: "unknown"` the only identifying evidence
lives in the `tasks.error` row, and nothing correlates it to the request shape.
Observed live: an opaque `litellm.BadRequestError: OpenrouterException — Message:
ERROR, Metadata: {'error_type': 'invalid_request'}` on the demo deployment, with
no way to tell from logs which model, how many steps in, or whether the mid-turn
brake had armed.

Counting `unknown` as an admin-visible number is the cheaper half of this: a wave
of opaque provider 400s should arrive as a metric, not as a screenshot.

---

## Suggested order

1. ~~**B1**~~ — done: `message_effects`, keyed `(message_id, tool_call_id)`, read on
   the continuation path with `parts` left as a one-release fallback.
2. **B2** — a shipped feature is inert on a whole class of providers, and it is
   the class with no server-side edit to fall back on.
3. **D1** — before any threshold tuning, since it means the cut currently
   disagrees with the policy it claims to share.
4. **B5** — an aggregate ceiling that holds regardless of provider behaviour.
5. **A2** — real accumulation, but only with our own depth gate and after
   confirming the model actually in play.
6. **A1** — the largest win and the largest change; narrow adoption in the
   post-turn job, and only with `contextTokens` split off from the summed usage.
7. **D4, D2** — small, and D4 is what makes the next opaque failure diagnosable.
8. **D3, C3, A4** — integrity edge, design research, and measurement.

Done in this pass: **B3, C1, C2**, plus the A5 comment correction and a stale
comment in `build.ts` that claimed tool clearing runs only at a compaction event
when the runner passes it on every deep turn.

## Sources

- [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Prompt caching — Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Prompt caching — OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Context caching — Gemini](https://ai.google.dev/gemini-api/docs/caching)

### D5 · A rejected call counted as work worth keeping — **DONE**

Found by another session while reviewing `invalidCalls`, and a genuine sibling of
it. The SDK synthesizes a `tool-error` for a call it rejected BEFORE running —
unparseable arguments, unknown tool — and `producedWork` in `errors/friendly.ts`
plus its SQL twin `PRODUCED_WORK_SQL` in `queue.ts` both counted any `tool-error`
part as work. So a turn cut short right after such a call told the user "what it
finished above is kept — ask it to continue" when nothing had run.

Fixed at part creation, by MARKING rather than skipping: the part still has to
exist, because dropping it orphans the call and an orphaned tool call is a hard 400.
`invalid: true` on the part, excluded by both readers.

The SQL twin had **no test at all** — which is exactly how a predicate and its copy
in another language drift apart. It has one now, against a real reconcile.
