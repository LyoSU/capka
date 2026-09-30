import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { expectWireShape, type WireMsg } from "./wire-shape";

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
// What the next provider call answers: text, or a new gated call (a second round).
const replies: ("text" | "gated")[] = [];
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as WireMsg[]);
        const gated = replies.shift() === "gated";
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(gated
                ? [{ type: "tool-call", toolCallId: "c9", toolName: "save_row", input: JSON.stringify({ row: "next" }) }]
                : [{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Done." }, { type: "text-end", id: "1" }]),
              {
                type: "finish",
                finishReason: gated ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
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
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: {
      save_row: tool({
        inputSchema: z.object({ row: z.string() }),
        needsApproval: true,
        execute: async (input) => { writes.push(input); return "saved"; },
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
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  listFiles: async () => ({ entries: [], truncated: false }),
}));
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { pool } from "../db";
import { runAgentTask, type ClaimedTask } from "../tasks/runner";
import { cancelQueuedTurn } from "../tasks/queue";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "aplc-user";
const C = "aplc-chat";

type Part = { type: string; id?: string; name?: string; output?: { code?: string; error?: string }; approval?: unknown };

/** A suspended row whose one gated call now carries the user's decision. */
async function seedSuspended(chat: string, call: { name: string; approved: boolean }) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [chat, U]);
  await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ($1,$2,'user','save the row')`, [`${chat}-u1`, chat]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','',$4::jsonb)`,
    [`${chat}-a1`, chat, `${chat}-u1`, JSON.stringify({
      status: "awaiting_approval",
      parts: [{ type: "tool-call", id: "c2", name: call.name, input: { row: "final" }, approval: { id: "ap1", approved: call.approved } }],
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
  return rows[0].metadata as { status: string; error?: string; parts: Part[] };
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
  });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  // The SDK re-checks an approved call and denies it when its tool is missing from the
  // toolset (a connector that failed to connect for this run) or no longer gated.
  it.each([
    ["gone", "gone_tool", /not available/],
    ["ungated", "read_row", /no longer asks for approval/],
  ])("stores a result for an approved call whose tool is %s", async (kind, name, why) => {
    const chat = `${C}-${kind}`;
    await seedSuspended(chat, { name, approved: true });

    expect(await continueApproval(chat)).toBe("completed");

    const row = await storedRow(chat);
    expect(row.status).toBe("completed");
    const [result] = resultFor(row.parts, "c2");
    expect(result.output).toMatchObject({ code: "NOT_RUN", error: expect.stringMatching(why) });
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

  // prepareRun throws before any stream: the chat's project was deleted while the card
  // waited. The row exists, so a failure path that inserted one rolled back on its id
  // and left the task running and the card spinning.
  it("settles its own row when the continuation cannot start", async () => {
    const chat = `${C}-noproject`;
    await seedSuspended(chat, { name: "save_row", approved: true });

    expect(await continueApproval(chat, { projectId: "aplc-deleted-project" })).toBe("failed");

    const row = await storedRow(chat);
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(["NOT_RUN"]);
    expect(row.parts.find((p) => p.type === "tool-call" && p.id === "c2")?.approval).toEqual({ id: "ap1", approved: true });
    const { rows } = await pool.query(`SELECT id FROM messages WHERE chat_id=$1 ORDER BY id`, [chat]);
    expect(rows.map((r) => r.id)).toEqual([`${chat}-a1`, `${chat}-u1`]);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
  }, 30_000);

  // Stop pressed while the continuation was still queued, and a worker claimed it anyway.
  it.each([
    ["approved", true, ["NOT_RUN"]],
    ["declined", false, []],
  ])("settles a %s row whose continuation was cancelled before it ran", async (kind, approved, codes) => {
    const chat = `${C}-cancel-${kind}`;
    await seedSuspended(chat, { name: "save_row", approved });

    expect(await continueApproval(chat, {}, true)).toBe("cancelled");

    const row = await storedRow(chat);
    expect(row.status).toBe("cancelled");
    // A declined call keeps its decision alone, so its card still reads "declined".
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(codes);
    expect(prompts).toEqual([]);
    expect(writes).toEqual([]);
  }, 30_000);

  // The same Stop, with the row removed before any worker saw it.
  it("settles the row when a queued continuation is removed", async () => {
    const chat = `${C}-dequeue`;
    await seedSuspended(chat, { name: "save_row", approved: true });
    await pool.query(
      `INSERT INTO tasks (id, chat_id, user_id, status, payload) VALUES ($1,$2,$3,'queued',$4::jsonb)`,
      [`${chat}-task`, chat, U, JSON.stringify({ resumeMessageId: `${chat}-a1` })],
    );

    expect(await cancelQueuedTurn({ id: `${chat}-task`, userId: U, chatId: chat })).toBe("removed");

    const row = await storedRow(chat);
    expect(row.status).toBe("cancelled");
    expect(resultFor(row.parts, "c2").map((r) => r.output?.code)).toEqual(["NOT_RUN"]);
  }, 30_000);
});
