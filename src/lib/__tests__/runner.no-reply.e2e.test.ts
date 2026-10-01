import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";

// A model that runs a tool and then ends the turn cleanly with no text at all — what a
// Gemini automation run did after a web search. The turn used to persist as a clean
// "completed": steps on screen, no answer, and nothing saying why. Now the runner
// continues once, and if there is still nothing, fails with a message that says so.
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };
const turn = { calls: 0, mode: "silent" as "silent" | "tool-then-silent" | "tool-then-answer" };

function step(i: number) {
  const empty = [{ type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage }];
  if (turn.mode === "silent") return empty;
  if (i === 0) {
    return [
      { type: "tool-call", toolCallId: "c0", toolName: "lookup", input: JSON.stringify({ q: "news" }) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
    ];
  }
  // The answer arrives only on the continuation the runner asks for (call 2).
  if (turn.mode === "tool-then-answer" && i >= 2) {
    return [
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here is the digest." }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage },
    ];
  }
  return empty;
}

vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...step(turn.calls++)] as any }),
      }),
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: { lookup: tool({ inputSchema: z.object({ q: z.string() }), execute: async () => "three headlines" }) },
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

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-noreply-user";
const C = "e2e-noreply-chat";

run("runAgentTask: the model ends the turn without a reply", () => {
  const cleanup = async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-noreply@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
  });
  beforeEach(async () => {
    await cleanup();
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('mnr1',$1,'user','daily digest')`, [C]);
    turn.calls = 0;
  });
  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  async function runTurn(id: string) {
    // Inserted already claimed, as in runner.e2e.test.ts: a dev worker polling the
    // same database would otherwise take a queued row first.
    const { rows } = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, chat_id, user_id, status, payload, worker_id, lease_expires_at, heartbeat_at, attempts)
       VALUES ($3, $1, $2, 'running', $4::jsonb, 'w-e2e-noreply', now() + interval '5 minutes', now(), 1)
       RETURNING *`,
      [C, U, id, JSON.stringify({ uiMessages: [{ id: "mnr1", role: "user", parts: [{ type: "text", text: "daily digest" }] }] })],
    );
    await runAgentTask(rows[0], "w-e2e-noreply");
    const msg = await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C]);
    const task = await pool.query(`SELECT status FROM tasks WHERE id=$1`, [id]);
    return { msg: msg.rows[0], status: task.rows[0].status as string };
  }

  it("tools ran, then silence even after a continuation: fails as a partial, keeping the steps", async () => {
    turn.mode = "tool-then-silent";
    const { msg, status } = await runTurn("e2e-noreply-1");
    expect(turn.calls).toBe(3); // tool step, the empty final step, one continuation
    expect(status).toBe("failed");
    expect(msg.metadata.status).toBe("failed");
    expect(msg.metadata.errorCategory).toBe("no_reply_partial");
  }, 30_000);

  it("the continuation produces the answer: completes normally", async () => {
    turn.mode = "tool-then-answer";
    const { msg, status } = await runTurn("e2e-noreply-2");
    expect(status).toBe("completed");
    expect(msg.content).toContain("Here is the digest.");
    expect(msg.metadata.errorCategory).toBeUndefined();
  }, 30_000);

  it("nothing at all, even after the empty-response retry: fails as no_reply", async () => {
    turn.mode = "silent";
    const { msg, status } = await runTurn("e2e-noreply-3");
    expect(status).toBe("failed");
    expect(msg.metadata.errorCategory).toBe("no_reply");
  }, 30_000);
});
