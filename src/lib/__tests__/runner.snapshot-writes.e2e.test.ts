import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool } from "ai";
import { z } from "zod";

// A mid-stream snapshot rewrites the whole reply row, so how often saveSnapshot writes
// and which columns it sets is the whole cost of streaming a long reply. Pinned here
// against the real runner rather than the interval function alone: one 200 KB text
// delta, then a second of reasoning. The large snapshot has to push the next unforced
// save past the old 1s cadence, and no mid-stream save may set `content` (under the
// full-text index) at all — only the finishing write does. Then a tool-heavy turn,
// where the writes come from tool events instead of text.
const BIG = "a".repeat(200_000);
const THOUGHTS = Array.from({ length: 10 }, (_, i) => `thought ${i}. `);

// The tool-heavy turn: STEPS sequential calls, each returning RESULT_BYTES (under
// the per-turn output cap and the forced wrap-up step), then a text answer. One
// call runs long, the way a sandbox command does, so a client reconnecting during
// it has to get its snapshot from the owed save rather than from the next event.
const STEPS = 20;
const RESULT_BYTES = 16_000;
const SLOW = 10;
const SLOW_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turn = { tools: false, calls: 0, probe: null as null | (() => Promise<void>) };

vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: turn.tools ? undefined : 100,
          chunks: (turn.tools ? toolStep(turn.calls++) : [
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
          ]) as any,
        }),
      }),
    }),
    provider: "mock",
    modelId: "mock-model",
  }),
}));
/** Step `i` of the tool-heavy turn: a call while there are calls left, then the answer. */
function toolStep(i: number) {
  const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };
  return [
    { type: "stream-start", warnings: [] },
    ...(i < STEPS
      ? [{ type: "tool-call", toolCallId: `c${i}`, toolName: "fetch_page", input: JSON.stringify({ n: i }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }]
      : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage }]),
  ];
}
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: turn.tools
      ? {
          fetch_page: tool({
            inputSchema: z.object({ n: z.number() }),
            execute: async ({ n }) => {
              if (n === SLOW) await turn.probe?.();
              else await sleep(20);
              return `${n}:`.padEnd(RESULT_BYTES, "x");
            },
          }),
        }
      : {},
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

import { db, pool } from "../db";
import { messages } from "../db/schema";
import { runAgentTask } from "../tasks/runner";
import type { TaskRow } from "../tasks/queue";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "e2e-snap-user";
const C = "e2e-snap-chat";
const C2 = "e2e-snap-tools";
const W = "w-e2e-snap";

type Meta = { status?: string; taskId?: string; parts?: { type: string; id?: string; text?: string }[] };

/** Every `SET` written to `messages`, in call order. */
function recordSets() {
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
  return sets;
}

/** Inserted already claimed rather than enqueued: a dev worker polling the same
 *  database would otherwise take a queued row first (and run it on a real model). */
async function claim(id: string, chat: string, parent: string) {
  const { rows } = await pool.query<TaskRow>(
    `INSERT INTO tasks (id, chat_id, user_id, status, payload, worker_id, lease_expires_at, heartbeat_at, attempts)
     VALUES ($1, $2, $3, 'running', $4::jsonb, $5, now() + interval '5 minutes', now(), 1)
     RETURNING *`,
    [id, chat, U, JSON.stringify({ replyParentId: parent }), W],
  );
  return rows[0];
}

run("runAgentTask: mid-stream snapshot writes", () => {
  const clean = async () => {
    await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id IN ($1,$2))`, [C, C2]);
    await pool.query(`DELETE FROM messages WHERE chat_id IN ($1,$2)`, [C, C2]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id IN ($1,$2)`, [C, C2]);
  };
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e2e-snap@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await clean();
    for (const chat of [C, C2]) await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2)`, [chat, U]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('ms1',$1,'user','hi')`, [C]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('ms2',$1,'user','read them all')`, [C2]);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("stretches the cadence for a large snapshot and never writes content mid-stream", async () => {
    const sets = recordSets();
    await runAgentTask(await claim("e2e-snap-1", C, "ms1"), W);

    const running = sets.filter((s) => (s.metadata as { status?: string } | undefined)?.status === "running");
    // The first flush after the big delta, then the step's forced save — no unforced
    // save a second later while the reasoning streamed (the old 1s cadence).
    expect(running).toHaveLength(2);
    expect(running.filter((s) => "content" in s)).toEqual([]);
    // The text rides in parts instead, from the first save on.
    const first = (running[0].metadata as { parts: { type: string; text?: string }[] }).parts;
    expect(first.find((p) => p.type === "text")?.text).toBe(BIG);
    const parts = (running[1].metadata as { parts: { type: string; text?: string }[] }).parts;
    expect(parts.find((p) => p.type === "reasoning")?.text).toBe(THOUGHTS.join(""));

    const msg = await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C]);
    expect(msg.rows[0].content).toBe(BIG);
    expect(msg.rows[0].metadata.status).toBe("completed");
  }, 30_000);

  // A tool step used to cost three full-row rewrites — the call, its result and the
  // step's end (a byte-identical copy of the result's) — so this turn wrote 62 rows
  // and 10.2 MB to leave a 320 KB reply (measured; 4 rows and 0.76 MB after). The
  // bound: at most one snapshot per TOOL_SAVE_MS (1 s) of turn, plus the first and
  // the stream end's, and fewer snapshots than tool steps however fast they come.
  it("writes a tool-heavy turn's snapshots at most once a second, and covers a long call while it runs", async () => {
    turn.tools = true;
    // Read the row the way a client mounting mid-call would, 1.2 s into the long call:
    // the call it is waiting on has to be there already.
    let duringCall: Meta | undefined;
    turn.probe = async () => {
      await sleep(1200);
      duringCall = (await pool.query(`SELECT metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C2])).rows[0]?.metadata;
      await sleep(SLOW_MS - 1200);
    };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    const sets = recordSets();
    const startedAt = Date.now();
    await runAgentTask(await claim("e2e-snap-2", C2, "ms2"), W);
    const durationMs = Date.now() - startedAt;

    // Control: every call ran and the reply completed with all of them.
    expect(turn.calls).toBe(STEPS + 1);
    const final = (await pool.query(`SELECT content, metadata FROM messages WHERE chat_id=$1 AND role='assistant'`, [C2])).rows[0];
    expect(final.metadata.status).toBe("completed");
    expect(final.content).toBe("Done.");
    expect((final.metadata as Meta).parts!.filter((p) => p.type === "tool-result")).toHaveLength(STEPS);

    expect(duringCall?.status).toBe("running");
    expect(duringCall?.parts?.some((p) => p.type === "tool-call" && p.id === `c${SLOW}`)).toBe(true);

    const running = sets.map((s) => s.metadata as Meta | undefined).filter((m) => m?.status === "running" && m.taskId === "e2e-snap-2");
    const bytes = running.reduce((n, m) => n + JSON.stringify(m!.parts).length, 0);
    const finalBytes = JSON.stringify(final.metadata.parts).length;
    expect(running.length).toBeLessThan(STEPS);
    expect(running.length).toBeLessThanOrEqual(Math.ceil(durationMs / 1000) + 2);
    expect(bytes).toBeLessThanOrEqual(running.length * finalBytes);
    // The finished line reports the same two figures, so an operator reads these
    // off real traffic.
    const finished = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
      .find((l) => l.msg === "task finished" && l.taskId === "e2e-snap-2");
    expect(finished).toMatchObject({ snapshotWrites: running.length, snapshotBytes: bytes });
  }, 30_000);
});
