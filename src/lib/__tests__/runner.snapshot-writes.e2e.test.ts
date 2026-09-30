import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

// A mid-stream snapshot rewrites the whole reply row, so how often saveSnapshot writes
// and which columns it sets is the whole cost of streaming a long reply. Pinned here
// against the real runner rather than the interval function alone: one 200 KB text
// delta, then a second of reasoning. The large snapshot has to push the next unforced
// save past the old 1s cadence, and the step's forced save — the text unchanged since
// the first save — has to leave `content` (under the full-text index) out of the SET.
const BIG = "a".repeat(200_000);
const THOUGHTS = Array.from({ length: 10 }, (_, i) => `thought ${i}. `);

vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 100,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: BIG },
            { type: "text-end", id: "t" },
            { type: "reasoning-start", id: "r" },
            ...THOUGHTS.map((delta) => ({ type: "reasoning-delta", id: "r", delta })),
            { type: "reasoning-end", id: "r" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
        }),
      }),
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({ tools: {}, close: async () => {} }),
}));
// Memory stubbed out whole — see the note in runner.e2e.test.ts.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { db, pool } from "../db";
import { messages } from "../db/schema";
import { runAgentTask } from "../tasks/runner";
import type { TaskRow } from "../tasks/queue";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-snap-user";
const C = "e2e-snap-chat";
const W = "w-e2e-snap";

run("runAgentTask: mid-stream snapshot writes", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-snap@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('ms1',$1,'user','hi')`, [C]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [C]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id=$1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("stretches the cadence for a large snapshot and leaves unchanged text out of the SET", async () => {
    const sets: Record<string, unknown>[] = [];
    const update = db.update.bind(db);
    vi.spyOn(db, "update").mockImplementation(((table: typeof messages) => {
      const builder = update(table);
      if (table !== messages) return builder;
      const set = builder.set.bind(builder);
      return Object.assign(builder, {
        set: (values: Record<string, unknown>) => { sets.push(values); return set(values); },
      });
    }) as never);

    // Inserted already claimed rather than enqueued: a dev worker polling the same
    // database would otherwise take a queued row first (and run it on a real model).
    const { rows } = await pool.query<TaskRow>(
      `INSERT INTO tasks (id, chat_id, user_id, status, payload, worker_id, lease_expires_at, heartbeat_at, attempts)
       VALUES ('e2e-snap-1', $1, $2, 'running', $3::jsonb, $4, now() + interval '5 minutes', now(), 1)
       RETURNING *`,
      [C, U, JSON.stringify({ replyParentId: "ms1" }), W],
    );
    await runAgentTask(rows[0], W);

    const running = sets.filter((s) => (s.metadata as { status?: string } | undefined)?.status === "running");
    // The first flush after the big delta, then the step's forced save — no unforced
    // save a second later while the reasoning streamed (the old 1s cadence).
    expect(running).toHaveLength(2);
    expect(running[0].content).toBe(BIG);
    expect("content" in running[1]).toBe(false);
    const parts = (running[1].metadata as { parts: { type: string; text?: string }[] }).parts;
    expect(parts.find((p) => p.type === "reasoning")?.text).toBe(THOUGHTS.join(""));

    const msg = await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C]);
    expect(msg.rows[0].content).toBe(BIG);
    expect(msg.rows[0].metadata.status).toBe("completed");
  }, 30_000);
});
