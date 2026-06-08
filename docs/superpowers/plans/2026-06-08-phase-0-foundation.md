# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make unClaw's agent execution durable, reliable, and secure on Postgres only — no in-memory coupling, no zombie tasks, no plaintext master key — and start capturing per-task usage.

**Architecture:** Agent tasks become rows in a Postgres-backed queue claimed by an in-process worker (started via `instrumentation.ts`) using `FOR UPDATE SKIP LOCKED` + lease/heartbeat. Realtime moves from an in-memory `eventBus` to Postgres `LISTEN/NOTIFY`. Cancellation is a DB flag (cross-process). Zombies (lease expired) are reconciled. Usage is recorded per task. Truth lives in Postgres, never in process memory.

**Tech Stack:** Next.js 16 (instrumentation `register()`), `pg` (raw client for LISTEN/NOTIFY + claim), Drizzle ORM, AI SDK 6, vitest.

**Pre-flight:** The bundled Next docs folder is empty; fetch Next 16 specifics (instrumentation `register`, route handler runtime) via the context7 MCP before writing the worker/SSE code. Run the dev DB (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up`) for integration checks.

---

## File Structure

- `src/lib/settings.ts` — modify `getMasterKey()` to read `UNCLAW_MASTER_KEY` env first.
- `src/lib/db/schema.ts` — modify `tasks` (add `leaseExpiresAt`, `heartbeatAt`, `workerId`, `cancelRequested`, `attempts`; status now includes `queued`), add `usage` table.
- `drizzle/000X_*.sql` — generated migration.
- `src/lib/pricing.ts` — **new.** Static model→price map + `costUsd(model, usage)`.
- `src/lib/usage.ts` — **new.** `recordUsage(...)` writes a `usage` row.
- `src/lib/realtime.ts` — **new.** Postgres LISTEN/NOTIFY: `publish(channel, data)`, `subscribe(channel, cb)`.
- `src/lib/tasks/queue.ts` — **new.** `enqueueTask`, `claimNextTask`, `heartbeat`, `finalizeTask`, `requestCancel`, `isCancelRequested`, `reconcileZombies`.
- `src/lib/tasks/runner.ts` — refactor: export `runAgentTask(payload)` invoked by the worker; remove in-memory `running` Map + fire-and-forget IIFE; cancel via DB flag → local `AbortController`; record usage on finalize; publish events via `realtime`.
- `src/lib/tasks/worker.ts` — **new.** Worker loop: LISTEN `task:enqueued` + poll fallback → claim → run; periodic `reconcileZombies`.
- `src/instrumentation.ts` — **new.** `register()` starts the worker (nodejs runtime only).
- `src/lib/events.ts` — remove (or thin shim) after callers migrate to `realtime`.
- `src/app/api/events/route.ts` — subscribe via `realtime` instead of `eventBus`.
- `src/app/api/chat/route.ts` — enqueue a task instead of `startTask` fire-and-forget.
- `src/app/api/tasks/[id]/cancel/route.ts` — `requestCancel(id)` (DB flag) instead of in-memory `cancelTask`.

---

## Task 1: Secure master key (env-first)

**Files:** Modify `src/lib/settings.ts`; Test `src/lib/__tests__/settings.test.ts` (create).

- [ ] **Step 1: Failing test** — `getMasterKey()` returns `process.env.UNCLAW_MASTER_KEY` when set; falls back to DB otherwise. (Mock `db`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — at top of `getMasterKey()`:

```ts
export async function getMasterKey(): Promise<string> {
  const envKey = process.env.UNCLAW_MASTER_KEY?.trim();
  if (envKey) { masterKeyCache = envKey; return envKey; }
  if (masterKeyCache) return masterKeyCache;
  const row = await db.select().from(settings).where(eq(settings.key, "auth_secret")).limit(1);
  if (row[0]) { masterKeyCache = row[0].value; return masterKeyCache; }
  console.warn("[security] UNCLAW_MASTER_KEY not set — generating and storing in DB (insecure; set the env var in production).");
  const secret = generateSecret();
  await db.insert(settings).values({ key: "auth_secret", value: secret, isEncrypted: false });
  masterKeyCache = secret;
  return secret;
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5:** Add `UNCLAW_MASTER_KEY=` to `.env.example` with a comment. Commit: `feat(security): master key root-of-trust from env`.

---

## Task 2: Schema — durable tasks + usage table

**Files:** Modify `src/lib/db/schema.ts`; generate migration.

- [ ] **Step 1: Modify `tasks`** — add columns:

```ts
// in tasks pgTable definition
leaseExpiresAt: timestamp("lease_expires_at"),
heartbeatAt: timestamp("heartbeat_at"),
workerId: text("worker_id"),
cancelRequested: boolean("cancel_requested").default(false),
attempts: integer("attempts").default(0),
// status comment: queued | running | completed | failed | cancelled
```
Add index: `index("idx_tasks_status_lease").on(table.status, table.leaseExpiresAt)`.

- [ ] **Step 2: Add `usage` table:**

```ts
export const usage = pgTable("usage", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  messageId: text("message_id"),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cachedInputTokens: integer("cached_input_tokens").default(0),
  costUsd: numeric("cost_usd"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("idx_usage_user_created").on(t.userId, t.createdAt), index("idx_usage_model").on(t.model)]);
```
(Import `numeric` from `drizzle-orm/pg-core`.)

- [ ] **Step 3:** `npx drizzle-kit generate` → review the generated SQL in `drizzle/`.
- [ ] **Step 4:** Apply: `npx drizzle-kit migrate` (against dev DB). Verify columns/table exist.
- [ ] **Step 5: Commit** `feat(db): durable task columns + usage table`.

---

## Task 3: Pricing + usage recording

**Files:** Create `src/lib/pricing.ts`, `src/lib/usage.ts`; Test `src/lib/__tests__/pricing.test.ts`.

- [ ] **Step 1: Failing test** — `costUsd("claude-opus-4-8", {inputTokens:1_000_000, outputTokens:0})` equals the catalog input price; unknown model → `null`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `pricing.ts`** — a `Record<string, {input:number; output:number}>` (USD per 1M tokens) for known Anthropic/OpenAI models, prefix-matched; `costUsd(model, usage)` returns number or null when unknown.
- [ ] **Step 4: Implement `usage.ts`** — `recordUsage({taskId, messageId, userId, provider, model, usage})` inserts a row with `nanoid()` id and computed `costUsd`. Wrap in try/catch (usage capture must never break a task).
- [ ] **Step 5: Run, verify pass. Commit** `feat(usage): pricing catalog + usage recording`.

---

## Task 4: Postgres realtime (LISTEN/NOTIFY)

**Files:** Create `src/lib/realtime.ts`; modify `src/app/api/events/route.ts`, `src/lib/tasks/runner.ts` (publisher) later.

- [ ] **Step 1: Implement `realtime.ts`** — one shared `pg` client for LISTEN (lazy, reconnecting), a `Map<channel, Set<cb>>` for in-process fanout, and `publish` via `pg_notify`. Channel = `user:<id>`. Payload is JSON; if `> 7500` bytes, send `{type:"refresh", ...minimal}` instead (client re-reads from DB).

```ts
import { Client } from "pg";
import { DATABASE_URL } from "@/lib/db";

type Cb = (data: unknown) => void;
const g = globalThis as unknown as { __rt?: RT };
class RT {
  private sub: Client | null = null;
  private pub: Client | null = null;
  private chans = new Map<string, Set<Cb>>();
  private async ensureSub() {
    if (this.sub) return;
    this.sub = new Client({ connectionString: DATABASE_URL });
    await this.sub.connect();
    this.sub.on("notification", (m) => {
      if (!m.channel || !m.payload) return;
      const cbs = this.chans.get(m.channel);
      if (!cbs) return;
      let data: unknown; try { data = JSON.parse(m.payload); } catch { return; }
      cbs.forEach((cb) => cb(data));
    });
    this.sub.on("error", () => { this.sub = null; }); // reconnect on next use
  }
  async subscribe(channel: string, cb: Cb): Promise<() => void> {
    await this.ensureSub();
    const ch = channelName(channel);
    if (!this.chans.has(ch)) { this.chans.set(ch, new Set()); await this.sub!.query(`LISTEN ${ch}`); }
    this.chans.get(ch)!.add(cb);
    return () => { this.chans.get(ch)?.delete(cb); };
  }
  async publish(channel: string, data: unknown) {
    if (!this.pub) { this.pub = new Client({ connectionString: DATABASE_URL }); await this.pub.connect(); }
    let payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > 7500) payload = JSON.stringify({ ...(data as object), _truncated: true });
    await this.pub.query("SELECT pg_notify($1, $2)", [channelName(channel), payload]);
  }
}
// Postgres channel identifiers: sanitize to a safe LISTEN name.
function channelName(c: string) { return "ch_" + c.replace(/[^a-zA-Z0-9_]/g, "_"); }
export const realtime = g.__rt ?? (g.__rt = new RT());
```

- [ ] **Step 2: Migrate `events/route.ts`** — replace `eventBus.subscribe(...)` with `await realtime.subscribe(\`user:${userId}\`, send)`; unsubscribe in `cancel()`.
- [ ] **Step 3: Manual check** — two terminals: one curls `/api/events`, one publishes; event arrives. (Defer publisher wiring to Task 6.)
- [ ] **Step 4: Commit** `feat(realtime): postgres LISTEN/NOTIFY transport`.

> NOTE on payload truncation: prefer keeping `text-delta` inline (small) and large `tool-result` events sending a minimal "result ready" signal so the client re-reads `parts` from the DB (progressive persist already writes them). Refine the publisher in Task 6 accordingly.

---

## Task 5: Queue helpers

**Files:** Create `src/lib/tasks/queue.ts`; Test `src/lib/__tests__/queue.test.ts` (logic-level where feasible; claim/reconcile validated against dev DB).

- [ ] **Step 1: Implement** using a raw `pg` pool query for the atomic claim:

```ts
// claimNextTask: atomic claim with SKIP LOCKED + lease
const LEASE_MS = 60_000;
export async function claimNextTask(workerId: string) {
  const { rows } = await pool.query(
    `UPDATE tasks SET status='running', worker_id=$1,
        lease_expires_at = now() + interval '60 seconds', heartbeat_at = now(),
        attempts = attempts + 1
     WHERE id = (
       SELECT id FROM tasks
       WHERE status='queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
  );
  return rows[0] ?? null;
}
```
Plus: `enqueueTask(row)` (insert `status='queued'` + `SELECT pg_notify('ch_task_enqueued','1')`), `heartbeat(id)` (extend lease), `finalizeTask(id, status, error?)`, `requestCancel(id)` (`UPDATE ... SET cancel_requested=true`), `isCancelRequested(id)` (`SELECT cancel_requested`), `reconcileZombies()` (`UPDATE tasks SET status='failed', error='worker lost' WHERE status='running' AND lease_expires_at < now()`).

- [ ] **Step 2: Test** the reconcile/claim against the dev DB: insert a queued row → `claimNextTask` returns it and flips status; a second concurrent claim returns null. A running row with past lease → `reconcileZombies` flips it to failed.
- [ ] **Step 3: Commit** `feat(tasks): postgres durable queue helpers`.

---

## Task 6: Refactor runner → `runAgentTask` (worker-invoked) + usage

**Files:** Modify `src/lib/tasks/runner.ts`.

- [ ] **Step 1:** Replace `startTask(opts)` (fire-and-forget) with `export async function runAgentTask(opts)` — the same streaming/consume logic, but: (a) no `running` Map; (b) cancellation via a local `AbortController` aborted when `isCancelRequested(taskId)` returns true (poll on each `finish-step` and via a periodic check); (c) on each `finish-step` also call `heartbeat(taskId)`; (d) publish events through `realtime.publish` instead of `eventBus.emit`; (e) on finalize, `recordUsage(...)` from the AI SDK `usage`; (f) `finalizeTask(taskId, status, error)`.
- [ ] **Step 2:** Keep the existing retry heuristics (vision-strip, empty-response) and progressive DB persist of `parts` unchanged.
- [ ] **Step 3:** Remove `cancelTask` export (cancel now via `requestCancel` in queue). Keep `closeMcp` cleanup in `finally`.
- [ ] **Step 4: Commit** `refactor(tasks): worker-invoked runAgentTask, db-flag cancel, usage capture`.

---

## Task 7: Worker loop + instrumentation

**Files:** Create `src/lib/tasks/worker.ts`, `src/instrumentation.ts`.

- [ ] **Step 1:** `worker.ts` — `startWorker()`: a singleton (guard on globalThis) that (a) `realtime.subscribe('task_enqueued', tick)`, (b) polls every 5s as fallback, (c) `tick()` loops `claimNextTask` until null, running each via `runAgentTask` with bounded concurrency (e.g. 3), (d) `setInterval(reconcileZombies, 30_000)`, (e) runs `reconcileZombies()` once on start.
- [ ] **Step 2:** `instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("@/lib/tasks/worker");
  await startWorker();
}
```
Verify Next 16 `instrumentation.ts` semantics via context7 first.

- [ ] **Step 3: Commit** `feat(tasks): in-process durable worker via instrumentation`.

---

## Task 8: Wire routes

**Files:** Modify `src/app/api/chat/route.ts`, `src/app/api/tasks/[id]/cancel/route.ts`.

- [ ] **Step 1:** In `chat/route.ts`, build the assistant message + task as before but set task `status='queued'` and store the run payload (model is reconstructed in the worker; persist enough to rebuild: chatId, userId, model id string, systemPrompt, uiMessages, nativeFiles, project sandbox network) — OR enqueue and let the worker re-resolve. Replace `startTask(...)` with `enqueueTask(...)`. Return `{ taskId, chatId }` unchanged so the client is unaffected.
- [ ] **Step 2:** In `cancel/route.ts`, replace `cancelTask(id)` with `await requestCancel(id)`; keep the DB status update fallback for already-finished tasks.
- [ ] **Step 3: Commit** `feat(api): enqueue tasks + cross-process cancel`.

> DECISION: to keep the worker self-contained, persist the run payload as a JSON column on the task (or a `task_payloads` row) so a worker on any instance can run it without the originating request's memory. The MCP/sandbox tools + model are re-resolved inside the worker from the persisted ids (re-call `resolveUserModel`, `loadSandboxTools`). This removes the last in-memory dependency.

---

## Task 9: Acceptance verification

- [ ] Kill the worker mid-task → task is reconciled to `failed` (or re-queued) within 30s; UI no longer shows eternal "running".
- [ ] Cancel from a different process path → `cancel_requested` flips, the running worker aborts.
- [ ] SSE delivers deltas via NOTIFY (simulate a second process by running the publisher from a script).
- [ ] Provider keys decrypt with `UNCLAW_MASTER_KEY` set in env.
- [ ] `usage` rows are written per finished task with non-null cost for known models.
- [ ] `npm run lint` and `npm run build` pass.

---

## Self-Review notes
- Spec §8 coverage: A (queue) → Tasks 5/7/8; B (NOTIFY) → Task 4; C (master key) → Task 1; D (zombie reconcile) → Tasks 5/7; E (usage) → Tasks 2/3/6. ✓
- Out of Phase 0 (do NOT start here): chat-state dedupe, memory v2/pgvector, modules/MCP registry, UI redesign, i18n — later phases.
