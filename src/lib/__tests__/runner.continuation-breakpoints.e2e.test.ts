import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { breakpoints, expectWireShape, type WireMsg } from "./wire-shape";

/**
 * Anthropic takes at most four cache breakpoints and rejects a fifth. A fresh turn
 * spends them on the stable tier, the previous turn's tail, this turn's tail and the
 * moving step tail (runner.turn-context counts those). An approval continuation
 * builds its prompt on its own road — the suspended half replayed, the approved
 * call run before the model is asked — so it is counted here, as Anthropic, past a
 * further tool step and through an overflow restart.
 */
const prompts: WireMsg[][] = [];
// What the next provider call does instead of answering with text.
const script: ("tool" | "overflow")[] = [];
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as WireMsg[]);
        const next = script.shift();
        if (next === "overflow") throw new Error("prompt is too long: 213456 tokens > 200000 maximum");
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(next === "tool"
                ? [{ type: "tool-call", toolCallId: "c3", toolName: "read_row", input: JSON.stringify({ row: "final" }) }]
                : [{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "Saved." }, { type: "text-end", id: "1" }]),
              {
                type: "finish",
                finishReason: next === "tool" ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
                usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any,
          }),
        };
      },
    }),
    provider: "anthropic",
    modelId: "mock-model",
  }),
  resolveAuxTarget: async (_userId: string, turn: unknown) => turn,
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: {
      save_row: tool({ inputSchema: z.object({ row: z.string() }), needsApproval: true, execute: async () => "saved" }),
      read_row: tool({ inputSchema: z.object({ row: z.string() }), execute: async () => "read" }),
    },
    close: async () => {},
  }),
}));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle: async () => "Rows" }));
// A workspace to list, so the turn context is on these prompts too.
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  listFiles: async () => ({ entries: [{ path: "rows.csv", isDirectory: false }], truncated: false }),
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

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "cbp-user";
const C = "cbp-chat";

/** A settled earlier turn, so there is a previous tail to mark, then a suspended
 *  reply whose gated call the user has just approved. */
async function seedSuspended(chat: string) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [chat, U]);
  await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ($1,$2,'user','open the sheet')`, [`${chat}-u0`, chat]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','Opened.',$4::jsonb)`,
    [`${chat}-a0`, chat, `${chat}-u0`, JSON.stringify({ status: "completed" })],
  );
  await pool.query(`INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ($1,$2,$3,'user','save the row')`, [`${chat}-u1`, chat, `${chat}-a0`]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','',$4::jsonb)`,
    [`${chat}-a1`, chat, `${chat}-u1`, JSON.stringify({
      status: "awaiting_approval",
      parts: [{ type: "tool-call", id: "c2", name: "save_row", input: { row: "final" }, approval: { id: "ap1", approved: true } }],
    })],
  );
  await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-a1`, chat]);
}

async function continueApproval(chat: string, steers: object[] = []) {
  // Written already-running: a `queued` row is a worker's to claim.
  const { rows } = await pool.query<ClaimedTask>(
    `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload, steers)
     VALUES ($1,$2,$3,'running','w-cbp', now() + interval '300 seconds', $4::jsonb, $5::jsonb)
     RETURNING *`,
    [`${chat}-task`, chat, U, JSON.stringify({ resumeMessageId: `${chat}-a1` }), JSON.stringify(steers)],
  );
  await runAgentTask(rows[0], "w-cbp");
  expect((await pool.query(`SELECT status FROM tasks WHERE id=$1`, [`${chat}-task`])).rows[0].status).toBe("completed");
}

run("runAgentTask: an approval continuation's cache breakpoints, as Anthropic", () => {
  const clean = async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id LIKE $1)`, [`${C}%`]);
    await pool.query(`DELETE FROM messages WHERE chat_id LIKE $1`, [`${C}%`]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id LIKE $1`, [`${C}%`]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','cbp@test.local') ON CONFLICT DO NOTHING`, [U]);
    await clean();
  });
  beforeEach(() => {
    prompts.length = 0;
    script.length = 0;
  });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("stays within four past a further tool step, with a steer waiting", async () => {
    const chat = `${C}-step`;
    await seedSuspended(chat);
    script.push("tool");
    await continueApproval(chat, [{ id: "s1", text: "use the final row", at: new Date().toISOString() }]);

    // Control: step 0 called a tool and step 1 answered, and the steer was sent.
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[0])).toContain("use the final row");
    for (const p of prompts) expectWireShape(p);
    // Stable + this turn's user message, then the step tail. One short of a fresh
    // turn's: the history ends on the reply being continued, so no earlier user
    // message is the previous turn's tail, and the mark on the approval's own tail
    // goes when the SDK swaps the approval for the call's result.
    expect(prompts.map(breakpoints)).toEqual([2, 3]);
  }, 30_000);

  it("stays within four on the overflow restart", async () => {
    const chat = `${C}-trim`;
    await seedSuspended(chat);
    script.push("overflow");
    await continueApproval(chat);

    // Control: the first attempt overflowed and the trimmed one was sent.
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expectWireShape(p);
    // The restart re-marks its rebuilt history, whose tail is now the call's result.
    expect(prompts.map(breakpoints)).toEqual([2, 3]);
  }, 30_000);
});
