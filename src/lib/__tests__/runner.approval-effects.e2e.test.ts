import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";

/**
 * An approval continuation whose first half already ran a tool used to lose the
 * approval. The continuation seeds its effect ledger from that half, so the
 * statement of what already ran goes to the first stream, and it went on as the
 * LAST message. The SDK only runs approvals found in the final message, so the
 * approved call never ran and the provider got a tool call with no result.
 *
 * The real road, because the defect is the runner's own message order: a suspended
 * row with one settled call and one approved call, and a continuation over it.
 */
type Msg = { role: string; content: unknown };
const prompts: Msg[][] = [];
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as Msg[]);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "1" },
              { type: "text-delta", id: "1", delta: "Saved." },
              { type: "text-end", id: "1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "end_turn" },
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
    },
    close: async () => {},
  }),
}));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle: async () => "Rows" }));
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
const U = "apfx-user";
const C = "apfx-chat";

run("runAgentTask: an approval continuation after a tool already ran", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','apfx@test.local') ON CONFLICT DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id=$1)`, [C]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('apfx-u1',$1,'user','save the row')`, [C]);
    // The suspended half: a read that ran, then a write the user has just approved.
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('apfx-a1',$1,'apfx-u1','assistant','',$2::jsonb)`,
      [C, JSON.stringify({
        status: "awaiting_approval",
        parts: [
          { type: "tool-call", id: "c1", name: "save_row", input: { row: "draft" } },
          { type: "tool-result", id: "c1", name: "save_row", output: "saved" },
          { type: "tool-call", id: "c2", name: "save_row", input: { row: "final" }, approval: { id: "ap1", approved: true } },
        ],
      })],
    );
    await pool.query(`UPDATE chats SET active_leaf_id='apfx-a1' WHERE id=$1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id=$1)`, [C]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("runs the approved call once and tells the model what already ran", async () => {
    // Written already-running: the dev stack's worker would claim a `queued` row.
    const { rows } = await pool.query<ClaimedTask>(
      `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
       VALUES ('apfx-task',$1,$2,'running','w-apfx', now() + interval '300 seconds', $3::jsonb)
       RETURNING *`,
      [C, U, JSON.stringify({ resumeMessageId: "apfx-a1" })],
    );
    await runAgentTask(rows[0], "w-apfx");
    const t = await pool.query(`SELECT status FROM tasks WHERE id='apfx-task'`);
    expect(t.rows[0].status).toBe("completed");

    // The finding: the approved call ran, once, before the model was asked anything.
    expect(writes).toEqual([{ row: "final" }]);
    const prompt = prompts.at(-1)!;
    const text = JSON.stringify(prompt);
    expect(text).toContain('"toolCallId":"c2"');
    const results = prompt.filter((m) => m.role === "tool")
      .flatMap((m) => m.content as { type: string; toolCallId: string }[])
      .filter((p) => p.type === "tool-result").map((p) => p.toolCallId);
    expect(results).toEqual(["c1", "c2"]);

    // Control: the effect note really was sent, so the order above was tested — it
    // names the call that ran, and sits before the reply that holds the approval.
    const note = prompt.findIndex((m) => m.role === "user" && JSON.stringify(m.content).includes("draft"));
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(prompt.findIndex((m) => m.role === "assistant"));
  }, 30_000);
});
