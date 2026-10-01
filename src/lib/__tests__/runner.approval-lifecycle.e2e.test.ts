import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { expectWireShape, type WireMsg } from "./wire-shape";

// A short stall window, so a slow call can outlast it; every mock reply here is instant.
vi.hoisted(() => { process.env.STREAM_IDLE_SECONDS = "3"; });

/**
 * Every way an approval continuation can end has to leave its row settled: an
 * approved call with a result (or its decision, when declined) and a status that is
 * not `awaiting_approval` unless a NEW call waits. A row left with an approved call
 * and no result spins on "Applying…" forever and feeds every later turn a bare tool
 * call, which providers reject.
 *
 * The real runner over a real database, because each road is the runner's own.
 */
const prompts: WireMsg[][] = [];
// What the next provider call answers: text ("Done." unless given), a new gated call
// (a second round), or a call that runs without asking.
const replies: ("text" | "gated" | "read" | { text: string })[] = [];
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as WireMsg[]);
        const next = replies.shift();
        const call = next === "gated" ? { id: "c9", name: "save_row" } : next === "read" ? { id: "c8", name: "read_row" } : null;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(call
                ? [{ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify({ row: "next" }) }]
                : [{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: typeof next === "object" ? next.text : "Done." }, { type: "text-end", id: "1" }]),
              {
                type: "finish",
                finishReason: call ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
                usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
          }),
        };
      },
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
  resolveAuxTarget: async (_userId: string, turn: unknown) => turn,
}));
const writes: unknown[] = [];
// How long the next save_row takes.
let slowWriteMs = 0;
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: {
      save_row: tool({
        inputSchema: z.object({ row: z.string() }),
        needsApproval: true,
        execute: async (input) => {
          if (slowWriteMs) await new Promise((r) => setTimeout(r, slowWriteMs));
          writes.push(input);
          return "saved";
        },
      }),
      // Asks for no approval (any more): the SDK drops an approval for it too.
      read_row: tool({
        inputSchema: z.object({ row: z.string() }),
        execute: async (input) => { writes.push(input); return "read"; },
      }),
    },
    close: async () => {},
  }),
}));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle: async () => "Rows" }));
// Set to make the turn's own finish write throw this once (a dropped connection, or
// an abort), which sends a turn whose stream already ran down the failure path.
let failNextCommit: Error | null = null;
// Set to make the next settle of a cancelled continuation's row throw once.
let failNextSettle = false;
vi.mock("@/lib/tasks/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks/queue")>();
  return {
    ...actual,
    settleCancelledContinuation: async (...args: Parameters<typeof actual.settleCancelledContinuation>) => {
      if (failNextSettle) {
        failNextSettle = false;
        throw new Error("Connection terminated unexpectedly");
      }
      return actual.settleCancelledContinuation(...args);
    },
    commitTurnOutcome: async (input: Parameters<typeof actual.commitTurnOutcome>[0]) => {
      if (failNextCommit) {
        const e = failNextCommit;
        failNextCommit = null;
        throw e;
      }
      return actual.commitTurnOutcome(input);
    },
  };
});
// A workspace to list, so the turn context is on these prompts. A test that needs a
// file this turn wrote adds it here, stamped with the moment it is listed.
const written: string[] = [];
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  listFiles: async () => ({
    entries: [
      { path: "rows.csv", isDirectory: false, size: 1, modifiedAt: null },
      ...written.map((path) => ({ path, isDirectory: false, size: 1, modifiedAt: new Date().toISOString() })),
    ],
    truncated: false,
  }),
}));
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { db, pool } from "../db";
import { runAgentTask, type ClaimedTask } from "../tasks/runner";
import { cancelQueuedTurn } from "../tasks/queue";
import { UNDECIDED_APPROVAL_REASON } from "../chat/tool-results";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "aplc-user";
const C = "aplc-chat";

type Part = { type: string; id?: string; name?: string; output?: { code?: string; reason?: string; error?: string }; approval?: unknown };

/** A suspended row whose one gated call now carries the user's decision. */
async function seedSuspended(chat: string, call: { name: string; approved: boolean }, meta: Record<string, unknown> = {}) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [chat, U]);
  await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ($1,$2,'user','save the row')`, [`${chat}-u1`, chat]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','',$4::jsonb)`,
    [`${chat}-a1`, chat, `${chat}-u1`, JSON.stringify({
      status: "awaiting_approval",
      parts: [{ type: "tool-call", id: "c2", name: call.name, input: { row: "final" }, approval: { id: "ap1", approved: call.approved } }],
      ...meta,
    })],
  );
  await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-a1`, chat]);
}

/** Run the continuation of `chat`'s suspended row; returns the task's final status. */
async function continueApproval(chat: string, payload: Record<string, unknown> = {}, cancelRequested = false) {
  // Written already-running: a `queued` row is a worker's to claim.
  const { rows } = await pool.query<ClaimedTask>(
    `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, cancel_requested, payload)
     VALUES ($1,$2,$3,'running','w-aplc', now() + interval '300 seconds', $4, $5::jsonb)
     RETURNING *`,
    [`${chat}-task`, chat, U, cancelRequested, JSON.stringify({ resumeMessageId: `${chat}-a1`, ...payload })],
  );
  await runAgentTask(rows[0], "w-aplc");
  return (await pool.query(`SELECT status FROM tasks WHERE id=$1`, [`${chat}-task`])).rows[0].status as string;
}

async function storedRow(chat: string) {
  const { rows } = await pool.query(`SELECT metadata FROM messages WHERE id=$1`, [`${chat}-a1`]);
  return rows[0].metadata as { status: string; error?: string; parts: Part[] } & Record<string, unknown>;
}

/** What the suspended half carried besides its parts: a steer, a file, its spend. */
const FIRST_HALF = {
  steers: [{ id: "s1", text: "use the final row", at: "2026-01-01T00:00:00.000Z", atStep: 1, afterToolCallId: null }],
  touchedFiles: ["rows.csv"],
  usage: { input: 100, output: 20, cached: 0 },
  costUsd: 0.01,
  durationMs: 1500,
  reasoningMs: 1000,
};

/** A failed continuation keeps the first half's steers and files, but not its (i)
 *  figures: shown under this run's model they read as the whole turn, and a failed
 *  turn owns the ErrorNotice instead, as on the success path. */
function expectFirstHalfKept(row: Record<string, unknown>) {
  expect(row).toMatchObject({ steers: FIRST_HALF.steers, touchedFiles: FIRST_HALF.touchedFiles });
  expect(row).not.toHaveProperty("usage");
  expect(row).not.toHaveProperty("costUsd");
  expect(row).not.toHaveProperty("durationMs");
}

const resultFor = (parts: Part[], id: string) => parts.filter((p) => p.type === "tool-result" && p.id === id);

run("runAgentTask: an approval continuation always settles its row", () => {
  const clean = async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id LIKE $1)`, [`${C}%`]);
    await pool.query(`DELETE FROM messages WHERE chat_id LIKE $1`, [`${C}%`]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id LIKE $1`, [`${C}%`]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','aplc@test.local') ON CONFLICT DO NOTHING`, [U]);
    await clean();
  });
  beforeEach(() => {
    prompts.length = 0;
    writes.length = 0;
    replies.length = 0;
    written.length = 0;
  });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  // The SDK re-checks an approved call and denies it when its tool is missing from the
  // toolset (a connector that failed to connect for this run) or no longer gated.
  it.each([
    ["gone", "gone_tool", /not available/, "tool_unavailable"],
    ["ungated", "read_row", /no longer asks for approval/, "rule_changed"],
  ])("stores a result for an approved call whose tool is %s", async (kind, name, why, reason) => {
    const chat = `${C}-${kind}`;
    await seedSuspended(chat, { name, approved: true });

    expect(await continueApproval(chat)).toBe("completed");

    const row = await storedRow(chat);
    expect(row.status).toBe("completed");
    const [result] = resultFor(row.parts, "c2");
    // The model reads `error`; `reason` is what the card can say it with.
    expect(result.output).toMatchObject({ code: "NOT_RUN", reason, error: expect.stringMatching(why) });
    expect(writes).toEqual([]);
    // The approval stays on the call, so the card keeps it and reads "didn't run".
    expect(row.parts.find((p) => p.type === "tool-call" && p.id === "c2")?.approval).toEqual({ id: "ap1", approved: true });
    // Control: the continuation did reach the model, and the denial was its answer for c2.
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain('"toolCallId":"c2"');
    for (const p of prompts) expectWireShape(p);
  }, 30_000);

  // The case the presenter cannot heal at read time: the same run then asks for a NEW
  // approval, so the row goes back to `awaiting_approval` with the dropped call on it.
  it("keeps that result when the continuation suspends again on a new call", async () => {
    const chat = `${C}-again`;
    await seedSuspended(chat, { name: "gone_tool", approved: true });
    replies.push("gated");

    expect(await continueApproval(chat)).toBe("completed");

    const row = await storedRow(chat);
    expect(row.status).toBe("awaiting_approval");
    expect(resultFor(row.parts, "c2")).toHaveLength(1);
    // Control: the new call is the one waiting, undecided and without a result.
    const next = row.parts.find((p) => p.type === "tool-call" && p.id === "c9");
    expect(next?.approval).toMatchObject({ id: expect.any(String) });
    expect(resultFor(row.parts, "c9")).toHaveLength(0);
    expect(writes).toEqual([]);
  }, 30_000);

  it("runs an approved call whose tool is present, and adds no second result", async () => {
    const chat = `${C}-present`;
    await seedSuspended(chat, { name: "save_row", approved: true });

    expect(await continueApproval(chat)).toBe("completed");

    expect(writes).toEqual([{ row: "final" }]);
    const results = resultFor((await storedRow(chat)).parts, "c2");
    expect(results.map((r) => r.output)).toEqual(["saved"]);
  }, 30_000);

  // The SDK streams no `tool-call` for an approved call it runs ahead of the first
  // step, so nothing paused the stall watchdog for it: a write slower than the window
  // read as a hung model, and the retry ran it a second time.
  it("does not take a slow approved call for a stalled model", async () => {
    const chat = `${C}-slow`;
    await seedSuspended(chat, { name: "save_row", approved: true });
    slowWriteMs = 4_000;

    try {
      expect(await continueApproval(chat)).toBe("completed");
    } finally {
      slowWriteMs = 0;
    }

    expect(writes).toEqual([{ row: "final" }]);
    expect(resultFor((await storedRow(chat)).parts, "c2").map((r) => r.output)).toEqual(["saved"]);
    expect(prompts).toHaveLength(1);
  }, 30_000);

  // The first half's files were found in its own tool windows, which the
  // continuation's listing cannot see — they have to be carried, not re-derived.
  it("keeps the first half's files beside the ones the continuation wrote", async () => {
    const chat = `${C}-files`;
    await seedSuspended(chat, { name: "save_row", approved: true }, FIRST_HALF);
    replies.push("read");
    written.push("out.csv");

    expect(await continueApproval(chat)).toBe("completed");

    // Control: a call ran in this half's own window.
    expect(writes).toEqual([{ row: "final" }, { row: "next" }]);
    expect((await storedRow(chat)).touchedFiles).toEqual(["out.csv", "rows.csv"]);
  }, 30_000);

  // The SDK runs the approved call ahead of the first step, without the `tool-call`
  // event that opens every other call's window, so what it wrote went unlisted.
  it("lists the files the approved call itself wrote", async () => {
    const chat = `${C}-files-approved`;
    await seedSuspended(chat, { name: "save_row", approved: true });
    written.push("out.csv");

    expect(await continueApproval(chat)).toBe("completed");

    // Control: the approved call ran, and it is the only call this half made.
    expect(writes).toEqual([{ row: "final" }]);
    expect((await storedRow(chat)).touchedFiles).toEqual(["out.csv"]);
  }, 30_000);

  // One run is capped at MAX_TOUCHED; the turn's two halves together are held to the same.
  it("caps the files of both halves together, this half's first", async () => {
    const chat = `${C}-files-cap`;
    const firstFiles = Array.from({ length: 12 }, (_, i) => `f${i + 1}.csv`);
    await seedSuspended(chat, { name: "save_row", approved: true }, { ...FIRST_HALF, touchedFiles: firstFiles });
    replies.push("read");
    written.push("out.csv");

    expect(await continueApproval(chat)).toBe("completed");

    expect((await storedRow(chat)).touchedFiles).toEqual(["out.csv", ...firstFiles.slice(0, 11)]);
  }, 30_000);

  it("keeps the first half's files when the continuation runs no tool", async () => {
    const chat = `${C}-files-declined`;
    await seedSuspended(chat, { name: "save_row", approved: false }, FIRST_HALF);

    expect(await continueApproval(chat)).toBe("completed");

    expect(writes).toEqual([]);
    expect((await storedRow(chat)).touchedFiles).toEqual(["rows.csv"]);
  }, 30_000);

  // Tier one is derived from the reply's text, so a file the reply now names would
  // otherwise show twice.
  it("drops a first-half file the continuation's reply names", async () => {
    const chat = `${C}-files-named`;
    await seedSuspended(chat, { name: "save_row", approved: false }, FIRST_HALF);
    replies.push({ text: "The rows are in /workspace/rows.csv." });

    expect(await continueApproval(chat)).toBe("completed");

    const row = await storedRow(chat);
    expect(row.touchedFiles).toBeUndefined();
    // Control: the reply that names it is the one stored.
    expect(JSON.stringify(row.parts)).toContain("/workspace/rows.csv");
  }, 30_000);

  // prepareRun throws before any stream: the chat's project was deleted while the card
  // waited. The row exists, so a failure path that inserted one rolled back on its id
  // and left the task running and the card spinning.
  it("settles its own row when the continuation cannot start", async () => {
    const chat = `${C}-noproject`;
    await seedSuspended(chat, { name: "save_row", approved: true }, FIRST_HALF);

    expect(await continueApproval(chat, { projectId: "aplc-deleted-project" })).toBe("failed");

    const row = await storedRow(chat);
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(["NOT_RUN"]);
    // Why it did not run is why the turn failed.
    expect(resultFor(row.parts, "c2")[0].output?.reason).toBe(row.errorCategory);
    expect(row.parts.find((p) => p.type === "tool-call" && p.id === "c2")?.approval).toEqual({ id: "ap1", approved: true });
    const { rows } = await pool.query(`SELECT id FROM messages WHERE chat_id=$1 ORDER BY id`, [chat]);
    expect(rows.map((r) => r.id)).toEqual([`${chat}-a1`, `${chat}-u1`]);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
    // The failure is written over the first half, not instead of it.
    expectFirstHalfKept(row);
  }, 30_000);

  // The same, after the approved call already ran and the reply was written.
  it("keeps the first half when the continuation fails after its stream started", async () => {
    const chat = `${C}-dropped`;
    await seedSuspended(chat, { name: "save_row", approved: true }, FIRST_HALF);
    failNextCommit = new Error("Connection terminated unexpectedly");

    expect(await continueApproval(chat)).toBe("failed");

    const row = await storedRow(chat);
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
    expectFirstHalfKept(row);
    // The activity group still says how long the whole turn reasoned, as on the success path.
    expect(row.reasoningMs).toBeGreaterThan(FIRST_HALF.reasoningMs);
    // Control: the stream had run — the call ran, kept its one result, and replied.
    expect(failNextCommit).toBe(null);
    expect(writes).toEqual([{ row: "final" }]);
    expect(resultFor(row.parts, "c2").map((r) => r.output)).toEqual(["saved"]);
    expect(prompts).toHaveLength(1);
  }, 30_000);

  // A cancel that reaches the failure path reports the whole turn, as the success path
  // does: both halves folded, not the first half's figures under this run's model.
  it("folds both halves' figures when the continuation is cancelled on the failure path", async () => {
    const chat = `${C}-dropped-cancel`;
    await seedSuspended(chat, { name: "save_row", approved: true }, FIRST_HALF);
    failNextCommit = Object.assign(new Error("aborted"), { name: "AbortError" });

    expect(await continueApproval(chat)).toBe("cancelled");

    const row = await storedRow(chat);
    expect(row.status).toBe("cancelled");
    // Control: the stream ran and billed this run's 10 + 2 tokens over one call.
    expect(failNextCommit).toBe(null);
    expect(prompts).toHaveLength(1);
    expect(row).toMatchObject({
      steers: FIRST_HALF.steers, touchedFiles: FIRST_HALF.touchedFiles,
      model: "mock-model", usage: { input: 110, output: 22, cached: 0 }, llmCalls: 1,
    });
    expect(row.durationMs).toBeGreaterThanOrEqual(FIRST_HALF.durationMs);
    expect(row.costUsd).toBeGreaterThanOrEqual(FIRST_HALF.costUsd);
  }, 30_000);

  // The read of the suspended row is what failed. Its row exists, so nothing may be
  // inserted under its id: that rolled back and left the card waiting for good.
  it("settles its own row when reading it fails", async () => {
    const chat = `${C}-unread`;
    await seedSuspended(chat, { name: "save_row", approved: true }, FIRST_HALF);
    const select = db.select.bind(db);
    let thrown = false;
    const spy = vi.spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      if (!thrown && fields && "parentId" in fields && "metadata" in fields) {
        thrown = true;
        throw new Error("Connection terminated unexpectedly");
      }
      return select(fields as never);
    }) as typeof db.select);

    try {
      expect(await continueApproval(chat)).toBe("failed");
    } finally {
      spy.mockRestore();
    }

    expect(thrown).toBe(true);
    const row = await storedRow(chat);
    expect(row.status).toBe("failed");
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(["NOT_RUN"]);
    expectFirstHalfKept(row);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
  }, 30_000);

  // Stop pressed while the continuation was still queued, and a worker claimed it anyway.
  it.each([
    ["approved", true, ["NOT_RUN"], ["stopped"]],
    ["declined", false, [], []],
  ])("settles a %s row whose continuation was cancelled before it ran", async (kind, approved, codes, reasons) => {
    const chat = `${C}-cancel-${kind}`;
    await seedSuspended(chat, { name: "save_row", approved });

    expect(await continueApproval(chat, {}, true)).toBe("cancelled");

    const row = await storedRow(chat);
    expect(row.status).toBe("cancelled");
    // A declined call keeps its decision alone, so its card still reads "declined".
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(codes);
    expect(resultFor(row.parts, "c2").map((r) => r.output?.reason)).toEqual(reasons);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
  }, 30_000);

  // Committing the cancel first and settling after left the row waiting for good when
  // the settle threw: the outcome was taken, so the failure path stood down.
  it("leaves no row waiting when settling a cancelled continuation fails", async () => {
    const chat = `${C}-cancel-settle`;
    await seedSuspended(chat, { name: "save_row", approved: true });
    failNextSettle = true;

    // The cancel rolled back with the settle, so the failure path still owned the
    // outcome and wrote it over the row.
    expect(await continueApproval(chat, {}, true)).toBe("failed");

    expect(failNextSettle).toBe(false);
    const row = await storedRow(chat);
    expect(row.status).toBe("failed");
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(["NOT_RUN"]);
    expect(resultFor(row.parts, "c2")[0].output?.reason).toBe(row.errorCategory);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
  }, 30_000);

  // The same Stop, with the row removed before any worker saw it. An answered ask
  // already has its result, so only its status moves.
  it.each([
    ["approval", ["NOT_RUN"], ["stopped"]],
    ["ask", [undefined], [undefined]],
  ])("settles the row when a queued %s continuation is removed", async (kind, codes, reasons) => {
    const chat = `${C}-dequeue-${kind}`;
    await seedSuspended(chat, { name: "save_row", approved: true }, kind === "ask" ? {
      status: "awaiting_answer",
      parts: [
        { type: "tool-call", id: "c2", name: "ask", input: {}, answer: { form: { question: "Which row?" }, value: { action: "accept", values: { row: "final" } } } },
        { type: "tool-result", id: "c2", name: "ask", output: { action: "accept", values: { row: "final" } } },
      ],
    } : {});
    await pool.query(
      `INSERT INTO tasks (id, chat_id, user_id, status, payload) VALUES ($1,$2,$3,'queued',$4::jsonb)`,
      [`${chat}-task`, chat, U, JSON.stringify({ resumeMessageId: `${chat}-a1` })],
    );

    expect(await cancelQueuedTurn({ id: `${chat}-task`, userId: U, chatId: chat })).toBe("removed");

    const row = await storedRow(chat);
    expect(row.status).toBe("cancelled");
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(codes);
    expect(resultFor(row.parts, "c2").map((r) => r.output?.reason)).toEqual(reasons);
    expect((await pool.query(`SELECT id FROM tasks WHERE id=$1`, [`${chat}-task`])).rows).toEqual([]);
  }, 30_000);

  // A follow-up queued while the reply ran, and the reply then stopped on a card: the
  // follow-up's turn goes past a call nobody will decide. That turn used to die with
  // AI_MissingToolResultsError before reaching the model, and so did every later one.
  it("a turn that goes past an undecided card answers, with the call declined, and settles the card", async () => {
    const chat = `${C}-past`;
    await seedSuspended(chat, { name: "save_row", approved: undefined as unknown as boolean });
    await pool.query(`INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ($1,$2,$3,'user','never mind')`, [`${chat}-u2`, chat, `${chat}-a1`]);
    await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-u2`, chat]);
    const { rows } = await pool.query<ClaimedTask>(
      `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
       VALUES ($1,$2,$3,'running','w-aplc', now() + interval '300 seconds', $4::jsonb) RETURNING *`,
      [`${chat}-task`, chat, U, JSON.stringify({ replyParentId: `${chat}-u2` })],
    );
    await runAgentTask(rows[0], "w-aplc");

    expect((await pool.query(`SELECT status FROM tasks WHERE id=$1`, [`${chat}-task`])).rows[0].status).toBe("completed");
    expect(writes).toEqual([]);
    expect(prompts).toHaveLength(1);
    expectWireShape(prompts[0]);
    expect(JSON.stringify(prompts[0])).toContain(JSON.stringify(UNDECIDED_APPROVAL_REASON));
    const row = await storedRow(chat);
    expect(row.status).toBe("completed");
    expect(row.parts.find((p) => p.id === "c2")?.approval).toEqual({ id: "ap1", approved: false, reason: UNDECIDED_APPROVAL_REASON });
  }, 30_000);

  // The SDK runs an approval only when its response is the LAST message it is handed.
  // Everything a continuation adds to the history — the turn context folded into the
  // user's message, the note of what already ran, a steer given before the approval
  // and one the first half never read — has to land before the reply holding the call.
  it("runs the approved call with every addition to its history in place", async () => {
    const chat = `${C}-order`;
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2)`, [chat, U]);
    const steer = (id: string, text: string) => ({ id, text, at: new Date().toISOString() });
    await pool.query(
      `INSERT INTO tasks (id, chat_id, user_id, status, steers) VALUES ($1,$2,$3,'completed',$4::jsonb)`,
      [`${chat}-t0`, chat, U, JSON.stringify([steer("s1", "use the final row"), steer("s2", "and keep it short")])],
    );
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ($1,$2,'user','save the row')`, [`${chat}-u1`, chat]);
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','',$4::jsonb)`,
      [`${chat}-a1`, chat, `${chat}-u1`, JSON.stringify({
        status: "awaiting_approval", taskId: `${chat}-t0`,
        steers: [{ ...steer("s1", "use the final row"), atStep: 1, afterToolCallId: "c1" }],
        parts: [
          { type: "tool-call", id: "c1", name: "save_row", input: { row: "draft" } },
          { type: "tool-result", id: "c1", name: "save_row", output: "saved" },
          { type: "tool-call", id: "c2", name: "save_row", input: { row: "final" }, approval: { id: "ap1", approved: true } },
        ],
      })],
    );
    await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-a1`, chat]);

    expect(await continueApproval(chat)).toBe("completed");

    // The finding this pins: the approved call ran, once.
    expect(writes).toEqual([{ row: "final" }]);
    const [prompt] = prompts;
    expectWireShape(prompt);
    const reply = prompt.findIndex((m) => m.role === "assistant" && JSON.stringify(m.content).includes('"toolCallId":"c2"'));
    expect(prompt[reply + 1]).toMatchObject({ role: "tool" });
    expect(JSON.stringify(prompt[reply + 1].content)).toContain('"toolCallId":"c2"');
    // Control: each addition really was on this prompt, ahead of that reply.
    const before = JSON.stringify(prompt.slice(0, reply));
    for (const text of ["rows.csv", "use the final row", "draft"]) expect(before).toContain(text);
    expect(JSON.stringify(prompt)).toContain("and keep it short");
  }, 30_000);
});
