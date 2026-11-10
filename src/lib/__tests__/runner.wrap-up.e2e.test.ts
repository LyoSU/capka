import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";

// A turn that runs out of budget used to have its tools taken away in silence: the
// model was never told why, so it wrote a "done" that hid the unfinished half, or
// nothing at all. This drives a two-step turn whose first tool result alone exceeds
// the per-turn tool-output budget, and pins what the wrap-up step must look like on
// the wire, and that nothing of it reaches the stored reply.
//
// The output budget is the brake used here because it is the one a test can trip in
// one step; the step and clock brakes go through the same `wrapUpReason` and the
// same append (unit-tested in step-control.test.ts).
vi.hoisted(() => { process.env.MAX_TURN_TOOL_OUTPUT_CHARS = "10"; });

type CallOpts = { prompt: unknown; toolChoice?: { type: string }; tools?: unknown[] };
const calls: CallOpts[] = [];
const finish = (unified: string, raw: string) => ({
  type: "finish",
  finishReason: { unified, raw },
  usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
});
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        calls.push(opts as unknown as CallOpts);
        const first = calls.length === 1;
        return {
          stream: simulateReadableStream({
            chunks: (first
              ? [
                  { type: "stream-start", warnings: [] },
                  { type: "tool-call", toolCallId: "t1", toolName: "read_all", input: JSON.stringify({}) },
                  finish("tool-calls", "tool_use"),
                ]
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "1" },
                  { type: "text-delta", id: "1", delta: "Half is done: /workspace/a.docx. Ask me to continue for the rest." },
                  { type: "text-end", id: "1" },
                  finish("stop", "end_turn"),
                ]
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ) as any,
          }),
        };
      },
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: { read_all: tool({ inputSchema: z.object({}), execute: async () => "a result well over ten characters long" }) },
    close: async () => {},
  }),
}));
// Memory stubbed out whole — see the note in runner.e2e.test.ts.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { pool } from "../db";
import type { TaskRow } from "../tasks/queue";
import { runAgentTask } from "../tasks/runner";
import { WRAP_UP_INSTRUCTION } from "../chat/context/step-control";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-wrapup-user";
const C = "e2e-wrapup-chat";
// A distinctive slice of the instruction, so a count over the serialized prompt
// cannot be fooled by a re-encoding of the surrounding text.
const MARK = WRAP_UP_INSTRUCTION.slice(0, 40);
const occurrences = (v: unknown) => JSON.stringify(v).split(MARK).length - 1;

run("runAgentTask: a turn that runs out of budget is told to wrap up", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-wrapup@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('mw1',$1,'user','analyse my files')`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("appends the instruction once, last, on the forced step only — and never stores it", async () => {
    // Inserted already claimed, as in runner.e2e.test.ts: a dev worker polling the
    // same database would otherwise take a queued row first.
    const { rows } = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, chat_id, user_id, status, payload, worker_id, lease_expires_at, heartbeat_at, attempts)
       VALUES ('e2e-wrapup-1', $1, $2, 'running', $3::jsonb, 'w-e2e-wrapup', now() + interval '5 minutes', now(), 1)
       RETURNING *`,
      [C, U, JSON.stringify({ uiMessages: [{ id: "mw1", role: "user", parts: [{ type: "text", text: "analyse my files" }] }] })],
    );
    await runAgentTask(rows[0], "w-e2e-wrapup");

    expect(calls).toHaveLength(2);
    // Step 0: an ordinary step — tools offered, no instruction.
    expect(calls[0].toolChoice?.type).not.toBe("none");
    expect(occurrences(calls[0].prompt)).toBe(0);
    // Step 1: tools withdrawn, and the model is told so — exactly once, at the end.
    expect(calls[1].toolChoice?.type).toBe("none");
    expect(occurrences(calls[1].prompt)).toBe(1);
    const last = (calls[1].prompt as { role: string }[]).at(-1);
    expect(last?.role).toBe("user");
    expect(occurrences(last)).toBe(1);

    const msg = await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C]);
    expect(msg.rows[0].metadata.status).toBe("completed");
    expect(msg.rows[0].metadata.wrapUp).toBe("output");
    // Not persisted as anyone's words: neither the reply nor its parts carry it, so
    // neither the transcript nor the next turn's history nor a compaction can.
    expect(occurrences(msg.rows[0])).toBe(0);
    const users = await pool.query(`SELECT count(*)::int AS n FROM messages WHERE chat_id=$1 AND role='user'`, [C]);
    expect(users.rows[0].n).toBe(1);
  }, 30_000);
});
