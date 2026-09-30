import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { expectWireShape, type WireMsg } from "./wire-shape";

/**
 * An approval continuation whose first half already ran a tool used to lose the
 * approval. The continuation seeds its effect ledger from that half, so the
 * statement of what already ran goes to the first stream, and it went on as the
 * LAST message. The SDK only runs approvals found in the final message, so the
 * approved call never ran and the provider got a tool call with no result.
 *
 * The real road, because the defect is the runner's own message order: a suspended
 * row with one settled call and one approved call, and a continuation over it.
 *
 * The same continuation restarted after the approved call ran lost its result the
 * other way: the SDK runs an approval before the first model call, the restart threw
 * that attempt away, and the history still ended on the bare approval. So the
 * provider got the call with no result, after the write had landed.
 *
 * Every prompt on these roads also carries the turn context and the note in the
 * user's own message, never as user messages of their own after it.
 */
type Msg = WireMsg;
const prompts: Msg[][] = [];
// What the next provider call does instead of answering: an overflow is thrown (the
// emergency-trim restart), a 503 arrives mid-reply (the stall/transient resume), a
// 503 is thrown before any output (a resume with nothing of its own to continue), or
// the reply ends with nothing in it (the empty-response retry).
const failures: ("overflow" | "transient" | "unavailable" | "empty")[] = [];
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as Msg[]);
        const fail = failures.shift();
        if (fail === "overflow") throw new Error("prompt is too long: 213456 tokens > 200000 maximum");
        if (fail === "unavailable") throw new Error("503 Service Unavailable");
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(fail === "transient"
                ? [
                    { type: "text-start", id: "1" },
                    { type: "text-delta", id: "1", delta: "Saving" },
                    { type: "error", error: new Error("503 Service Unavailable") },
                  ]
                : [
                    ...(fail === "empty" ? [] : [
                      { type: "text-start", id: "1" },
                      { type: "text-delta", id: "1", delta: "Saved." },
                      { type: "text-end", id: "1" },
                    ]),
                    {
                      type: "finish",
                      finishReason: { unified: "stop", raw: "end_turn" },
                      usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 2 } },
                    },
                  ]),
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
// What the client is told, so a reset can be checked against what it keeps on screen.
const published: TaskEvent[] = [];
vi.mock("@/lib/tasks/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks/events")>();
  return {
    ...actual,
    publishTaskEvent: async (userId: string, event: TaskEvent) => { published.push(event); return actual.publishTaskEvent(userId, event); },
  };
});
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
import type { TaskEvent } from "../tasks/events";
import { toUIMessages } from "../chat/presenter";
import { resetReply } from "@/hooks/use-background-chat";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "apfx-user";
const C = "apfx-chat";

/** A suspended half: a read that ran, then a write the user has just approved. */
const SUSPENDED = [
  { type: "tool-call", id: "c1", name: "save_row", input: { row: "draft" } },
  { type: "tool-result", id: "c1", name: "save_row", output: "saved" },
  { type: "tool-call", id: "c2", name: "save_row", input: { row: "final" }, approval: { id: "ap1", approved: true } },
];

async function seedSuspended(chat: string) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [chat, U]);
  await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ($1,$2,'user','save the row')`, [`${chat}-u1`, chat]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,'assistant','',$4::jsonb)`,
    [`${chat}-a1`, chat, `${chat}-u1`, JSON.stringify({
      status: "awaiting_approval",
      parts: SUSPENDED,
    })],
  );
  await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-a1`, chat]);
}

/** Continue the suspended row in `chat`; resolves once the task has finished. */
async function continueApproval(chat: string) {
  // Written already-running: the dev stack's worker would claim a `queued` row.
  const { rows } = await pool.query<ClaimedTask>(
    `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
     VALUES ($1,$2,$3,'running','w-apfx', now() + interval '300 seconds', $4::jsonb)
     RETURNING *`,
    [`${chat}-task`, chat, U, JSON.stringify({ resumeMessageId: `${chat}-a1` })],
  );
  await runAgentTask(rows[0], "w-apfx");
  const t = await pool.query(`SELECT status FROM tasks WHERE id=$1`, [`${chat}-task`]);
  expect(t.rows[0].status).toBe("completed");
}

/** How many parts of `type` in `role` messages carry this tool-call id. */
const count = (prompt: Msg[], role: string, type: string, id: string) =>
  prompt.filter((m) => m.role === role && Array.isArray(m.content))
    .flatMap((m) => m.content as { type: string; toolCallId?: string }[])
    .filter((p) => p.type === type && p.toolCallId === id).length;

run("runAgentTask: an approval continuation after a tool already ran", () => {
  const clean = async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id LIKE $1)`, [`${C}%`]);
    await pool.query(`DELETE FROM messages WHERE chat_id LIKE $1`, [`${C}%`]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id LIKE $1`, [`${C}%`]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','apfx@test.local') ON CONFLICT DO NOTHING`, [U]);
    await clean();
  });
  beforeEach(() => {
    prompts.length = 0;
    writes.length = 0;
    failures.length = 0;
    published.length = 0;
  });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("runs the approved call once and tells the model what already ran", async () => {
    await seedSuspended(C);
    await continueApproval(C);

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
    // …folded, with the turn context, into the user's own message: one text here (the
    // mock is no Anthropic), each folded message starting on a line of its own.
    const folded = (prompt[note].content as { text?: string }[]).map((p) => p.text ?? "");
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatch(/^save the row\n\n<turn-context>[\s\S]*rows\.csv[\s\S]*<\/turn-context>\n\n[\s\S]*draft/);
    for (const p of prompts) expectWireShape(p);
  }, 30_000);

  // Four restart roads: the overflow trim rebuilds the history from the settled rows,
  // the transient resume keeps it and appends the reply so far, a 503 before any
  // output leaves the resume nothing of its own, so it restarts clean, and so does an
  // empty reply. Either way the write already ran before the model was first asked,
  // so the retried prompt must hold its call and its result exactly once — and the
  // write must not run again.
  it.each(["overflow", "transient", "unavailable", "empty"] as const)("a %s restart sends the approved call with its result, once", async (kind) => {
    const chat = `${C}-${kind}`;
    await seedSuspended(chat);
    failures.push(kind);
    await continueApproval(chat);

    expect(writes).toEqual([{ row: "final" }]);
    // Control: the first attempt really failed and was retried.
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expectWireShape(p);
    const prompt = prompts[1];
    expect(count(prompt, "assistant", "tool-call", "c2")).toBe(1);
    expect(count(prompt, "tool", "tool-result", "c2")).toBe(1);
    // The suspended half is sent once too — the resume replays only this run's reply.
    expect(count(prompt, "assistant", "tool-call", "c1")).toBe(1);
    expect(count(prompt, "tool", "tool-result", "c1")).toBe(1);

    // And the stored reply keeps both halves: throwing the attempt away must not take
    // the approval card, the read or the write with it.
    const { rows } = await pool.query(`SELECT metadata FROM messages WHERE id=$1`, [`${chat}-a1`]);
    const parts = rows[0].metadata.parts as { type: string; id?: string; approval?: unknown; text?: string }[];
    expect(parts.filter((p) => p.id).map((p) => `${p.type}:${p.id}`))
      .toEqual(["tool-call:c1", "tool-result:c1", "tool-call:c2", "tool-result:c2"]);
    expect(parts.find((p) => p.type === "tool-call" && p.id === "c2")?.approval).toEqual({ id: "ap1", approved: true });
    expect(parts.at(-1)?.text).toMatch(/Saved\.$/);

    // The live view keeps them too: a reset leaves the two cards the page drew for the
    // suspended half, and drops only what the thrown-away attempt streamed after them.
    const resets = published.filter((e): e is Extract<TaskEvent, { type: "task:reset" }> => e.type === "task:reset");
    if (kind === "unavailable" || kind === "empty") expect(resets.length).toBeGreaterThan(0);
    const [suspended] = toUIMessages([{ id: `${chat}-a1`, role: "assistant", content: "", createdAt: null, platform: null,
      metadata: { status: "running", parts: SUSPENDED } }]);
    const live = [{ ...suspended, parts: [...suspended.parts, { type: "text", text: "Saving" }] }];
    for (const reset of resets) expect(resetReply(live, reset)[0].parts).toEqual(suspended.parts);
  }, 30_000);
});
