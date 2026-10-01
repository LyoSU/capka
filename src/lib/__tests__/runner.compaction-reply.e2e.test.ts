import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";

/**
 * Compaction must summarize the reply that triggered it. The checkpoint is written
 * BELOW that reply and the next turn drops everything up to the checkpoint, so a
 * summary made from the history alone — which ends at the user's message — erased
 * the reply: the model saw neither it nor a recap of it.
 *
 * Travels the real road because the defect is made of the runner's own wiring (which
 * list it hands the compactor), and covers the continuation, whose history already
 * ends at the very row being written — appending the reply there would replay its
 * first half twice.
 *
 * The same road carries the edges around it: a tool loop whose mid-turn prune armed,
 * a continuation holding tool calls and a steer, and a turn the overflow retry
 * trimmed — each changes which history the compactor must be handed.
 */
const REPLY = "There are forty-two active suppliers.";
const FIRST_HALF = "Which quarter did you mean?";
const compacted: ModelMessage[][] = [];
// The providerOptions each call was handed, in step with `compacted`.
const compactOpts: unknown[] = [];
// Read per turn, so one suite can run the same mock model as two providers.
let provider = "mock";
// The window the runner plans against, read in beforeAll the way run-context reads it.
let limit = 0;
// Every provider call's prompt, and what each next call does. An empty script answers
// REPLY past the compaction threshold; "overflow" rejects the prompt as too long, with
// no figure in it, so the runner learns no window from it; "echo" rejects the reasoning
// echoed back in it, the way a Cerebras backend behind LiteLLM does.
const prompts: ModelMessage[][] = [];
const script: (unknown[] | "overflow" | "echo")[] = [];
const finish = (unified: string, tokens: number) => ({
  type: "finish",
  finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: tokens, noCache: tokens }, outputTokens: { total: 8 } },
});
const answer = (tokens: number) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: REPLY },
  { type: "text-end", id: "1" },
  finish("stop", tokens),
];
const readStep = (id: string, tokens: number) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: "read_file", input: JSON.stringify({ path: `${id}.csv` }) },
  finish("tool-calls", tokens),
];
// Tool bodies: the ones an earlier turn read, and the ones this turn's reads return.
const OLD = "o".repeat(4_000);
const NEW = "n".repeat(4_000);
// What the compactor answers. Unset, it abstains and no checkpoint is written; a test
// that wants one sets this, and can do its racing inside before it returns.
let summarize: (() => Promise<string>) | undefined;
vi.mock("@/lib/chat/context/compactor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/context/compactor")>()),
  compactConversation: async (_m: unknown, _s: unknown, msgs: ModelMessage[], _t: unknown, _u: unknown, opts: unknown) => {
    compacted.push(msgs);
    compactOpts.push(opts);
    return summarize ? { text: await summarize(), trust: false } : null;
  },
}));
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({
    model: new MockLanguageModelV3({
      doStream: async (opts) => {
        prompts.push(opts.prompt as ModelMessage[]);
        // Past 75% of the window by default, so the turn trips compaction.
        const next = script.shift() ?? answer(Math.ceil(limit * 0.9));
        if (next === "overflow") throw new Error("prompt is too long");
        if (next === "echo") throw new Error("unexpected property: reasoning_content");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { stream: simulateReadableStream({ chunks: next as any }) };
      },
    }),
    provider,
    modelId: "mock-model",
  }),
  resolveAuxTarget: async (_userId: string, turn: unknown) => turn,
}));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle: async () => null }));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({
    tools: {
      read_file: tool({ inputSchema: z.object({ path: z.string() }), execute: async () => NEW }),
      save_row: tool({ inputSchema: z.object({ row: z.string() }), needsApproval: true, execute: async () => "saved" }),
    },
    close: async () => {},
  }),
}));
// Memory stubbed at the same seams the sibling e2e suites stub: this runs against the
// shared database and the real vault would leave rows behind for a fixture user.
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "e2e-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
vi.mock("@/lib/vault/extract", () => ({ extractFacts: async () => {} }));

import { pool } from "../db";
import { runAgentTask, type ClaimedTask } from "../tasks/runner";
import { auxInFlight } from "../tasks/queue";
import { contextBudget } from "../chat/context/budget";
import { contextManagementOptions } from "../chat/context/provider-edits";
import { getModelContextLength } from "../models/catalog";
import { getMaxContextTokens } from "../settings";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const U = "cmp-reply-user";
const C1 = "cmp-reply-chat";
const C2 = "cmp-reply-cont";
const C3 = "cmp-reply-anth";
// The edge suites seed their own chats under this prefix.
const CX = "cmp-edge";

/** A linear path of rows, each the parent of the next; the last becomes the leaf. */
async function seedPath(chatId: string, rows: { id: string; role: string; content?: string; metadata?: object }[]) {
  await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [chatId, U]);
  let parent: string | null = null;
  for (const r of rows) {
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [r.id, chatId, parent, r.role, r.content ?? "", JSON.stringify(r.metadata ?? null)],
    );
    parent = r.id;
  }
  await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [parent, chatId]);
}

/** An earlier turn that read two files, measured small enough that the next build keeps its bodies. */
const readTurn = (prefix: string) => [
  { id: `${prefix}-u1`, role: "user", content: "read p0 and p1" },
  { id: `${prefix}-a1`, role: "assistant", metadata: { status: "completed", contextTokens: 1_000, parts: [
    { type: "tool-call", id: `${prefix}-p0`, name: "read_file", input: { path: "p0.csv" } },
    { type: "tool-result", id: `${prefix}-p0`, name: "read_file", output: OLD },
    { type: "tool-call", id: `${prefix}-p1`, name: "read_file", input: { path: "p1.csv" } },
    { type: "tool-result", id: `${prefix}-p1`, name: "read_file", output: OLD },
    { type: "text", text: "Both read." },
  ] } },
  { id: `${prefix}-u2`, role: "user", content: "now read the rest" },
];

/** How many `type` parts in the list carry this tool-call id. */
const count = (msgs: ModelMessage[], type: string, id: string) =>
  msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; toolCallId?: string }[]) : []))
    .filter((p) => p.type === type && p.toolCallId === id).length;

async function runTask(id: string, chatId: string, payload: object, compacts = true) {
  // Written already-running rather than enqueued: the dev stack's own worker polls
  // this same database and would claim a `queued` row out from under this suite.
  const { rows } = await pool.query<ClaimedTask>(
    `INSERT INTO tasks (id, chat_id, user_id, status, worker_id, lease_expires_at, payload)
     VALUES ($1,$2,$3,'running','w-cmp', now() + interval '300 seconds', $4::jsonb)
     RETURNING *`,
    [id, chatId, U, JSON.stringify(payload)],
  );
  const before = compacted.length;
  await runAgentTask(rows[0], "w-cmp");
  // Compaction is fire-and-forget; wait for the call to land.
  for (let i = 0; compacts && i < 100 && compacted.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  const t = await pool.query(`SELECT status FROM tasks WHERE id=$1`, [id]);
  expect(t.rows[0].status).toBe("completed");
  expect(compacted.length).toBe(before + (compacts ? 1 : 0));
  // Every scripted call was made: a turn that stopped early tested nothing.
  expect(script).toHaveLength(0);
  return compacted.at(-1)!;
}

/** Wait out every fire-and-forget pass the turns dispatched. */
async function settle() {
  for (let i = 0; i < 200 && auxInFlight() > 0; i++) await new Promise((r) => setTimeout(r, 25));
  expect(auxInFlight()).toBe(0);
}

/** The reply a turn wrote under `parentId`. */
async function replyUnder(chatId: string, parentId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM messages WHERE chat_id=$1 AND parent_id=$2 AND role='assistant'`, [chatId, parentId]);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}
const checkpoints = async (chatId: string) =>
  (await pool.query(`SELECT id, parent_id FROM messages WHERE chat_id=$1 AND metadata ? 'compaction'`, [chatId])).rows;
const leafOf = async (chatId: string) =>
  (await pool.query(`SELECT active_leaf_id FROM chats WHERE id=$1`, [chatId])).rows[0].active_leaf_id;
const parentOf = async (id: string) =>
  (await pool.query(`SELECT parent_id FROM messages WHERE id=$1`, [id])).rows[0].parent_id;
/** A user message sent under `parentId`, made the leaf the way a send does. */
async function send(chatId: string, id: string, parentId: string) {
  await pool.query(`INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ($1,$2,$3,'user','and the year before?')`, [id, chatId, parentId]);
  await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [id, chatId]);
}

run("runAgentTask: compaction summarizes the reply that triggered it", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','cmp-reply@test.local') ON CONFLICT DO NOTHING`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    for (const c of [C1, C2, C3]) {
      await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [c, U]);
      await pool.query(`DELETE FROM messages WHERE chat_id=$1`, [c]);
    }
    await pool.query(`DELETE FROM messages WHERE chat_id LIKE $1`, [`${CX}%`]);
    limit = contextBudget({
      usedTokens: 0, modelContextLength: await getModelContextLength("mock-model"), adminCap: (await getMaxContextTokens()) || null,
    }).effectiveLimit;
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('cmp-u1',$1,'user','how many suppliers do we have?')`, [C1]);
    await pool.query(`UPDATE chats SET active_leaf_id='cmp-u1' WHERE id=$1`, [C1]);
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('cmp-u3',$1,'user','how many suppliers do we have?')`, [C3]);
    await pool.query(`UPDATE chats SET active_leaf_id='cmp-u3' WHERE id=$1`, [C3]);
    // A continuation: the assistant half that suspended on an `ask` is the leaf.
    await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('cmp-u2',$1,'user','report on suppliers')`, [C2]);
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('cmp-a2',$1,'cmp-u2','assistant','',$2::jsonb)`,
      [C2, JSON.stringify({ status: "awaiting_answer", parts: [{ type: "text", text: FIRST_HALF }] })],
    );
    await pool.query(`UPDATE chats SET active_leaf_id='cmp-a2' WHERE id=$1`, [C2]);
  });
  afterAll(async () => {
    for (const c of [C1, C2, C3, `${CX}%`]) {
      await pool.query(`DELETE FROM message_effects WHERE message_id IN (SELECT id FROM messages WHERE chat_id LIKE $1)`, [c]);
      await pool.query(`DELETE FROM messages WHERE chat_id LIKE $1`, [c]);
    }
    await pool.query(`DELETE FROM usage WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id=$1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id IN ($1,$2,$3) OR id LIKE $4`, [C1, C2, C3, `${CX}%`]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("hands the compactor the history AND the reply, reply last", async () => {
    const msgs = await runTask("cmp-task-1", C1, { replyParentId: "cmp-u1" });
    const conversation = msgs.filter((m) => m.role !== "system");
    // Control: the history is really there, ending at the user's message.
    expect(JSON.stringify(conversation.at(-2)!.content)).toContain("how many suppliers");
    // The finding: the reply follows it, so the summary can cover it.
    const last = conversation.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(JSON.stringify(last.content)).toContain(REPLY);
    // A provider we clear for ourselves gets no server-side edit.
    expect(compactOpts.at(-1)).toBeUndefined();
  }, 30_000);

  it("on a continuation, includes the whole reply once — not its first half twice", async () => {
    const msgs = await runTask("cmp-task-2", C2, { resumeMessageId: "cmp-a2" });
    const text = JSON.stringify(msgs.filter((m) => m.role !== "system"));
    expect(text).toContain(REPLY);
    expect(text.split(FIRST_HALF).length - 1).toBe(1);
    expect(msgs.at(-1)!.role).toBe("assistant");
  }, 30_000);

  it("hands an Anthropic compaction the live turn's server-side edit, sized to the same window", async () => {
    provider = "anthropic";
    try {
      await runTask("cmp-task-3", C3, { replyParentId: "cmp-u3" });
    } finally {
      provider = "mock";
    }
    // The window the runner sized the live edit against.
    expect(compactOpts.at(-1)).toEqual(contextManagementOptions("anthropic", limit));
  }, 30_000);

  it("after a tool loop whose mid-turn prune armed, hands over the history with its tool bodies cleared", async () => {
    const chat = `${CX}-loop`;
    await seedPath(chat, readTurn(chat));
    // Three reads past the clear trigger arm the prune; the answer then lands past 75%.
    for (const id of ["c0", "c1", "c2"]) script.push(readStep(id, Math.ceil(limit * 0.6)));
    const from = prompts.length;
    const msgs = await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u2` });
    // Control: the turn was built with the earlier bodies intact, so only the armed
    // prune can have cleared them.
    expect(JSON.stringify(prompts[from])).toContain(OLD);
    const text = JSON.stringify(msgs);
    expect(text).not.toContain(OLD);
    // Cleared, not dropped: the earlier turn is still there to be summarized.
    expect(text).toContain("read p0 and p1");
    expect(text).toContain("Both read.");
    expect(count(msgs, "tool-call", `${chat}-p0`)).toBe(1);
    expect(count(msgs, "tool-result", `${chat}-p0`)).toBe(1);
    expect(text).toContain(REPLY);
  }, 30_000);

  it("after an armed prune that ends under the trigger, still builds the next turn with the bodies cleared", async () => {
    const chat = `${CX}-sticky`;
    await seedPath(chat, readTurn(chat));
    for (const id of ["c0", "c1", "c2"]) script.push(readStep(id, Math.ceil(limit * 0.6)));
    // The pruned last step measures under the trigger, so no compaction either.
    script.push(answer(Math.ceil(limit * 0.3)));
    await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u2` }, false);
    const { rows } = await pool.query(`SELECT id, metadata FROM messages WHERE chat_id=$1 AND parent_id=$2`, [chat, `${chat}-u2`]);
    // Control: the persisted size alone would not have said "deep".
    expect(rows[0].metadata.contextTokens).toBeLessThan(limit * 0.5);
    expect(rows[0].metadata.toolsCleared).toBe(true);

    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ($1,$2,$3,'user','and summarize them')`,
      [`${chat}-u3`, chat, rows[0].id],
    );
    await pool.query(`UPDATE chats SET active_leaf_id=$1 WHERE id=$2`, [`${chat}-u3`, chat]);
    script.push(answer(1_000));
    const from = prompts.length;
    await runTask(`${chat}-task2`, chat, { replyParentId: `${chat}-u3` }, false);
    // The finding: the next turn's first request replayed every body the prune had shed.
    const first = JSON.stringify(prompts[from]);
    expect(first).toContain("read p0 and p1");
    expect(first).not.toContain(OLD);
  }, 30_000);

  it("on a continuation with tool calls and a steer, hands over each call and the steer once", async () => {
    const chat = `${CX}-cont`;
    const steer = "use metric units";
    await seedPath(chat, [
      { id: `${chat}-u1`, role: "user", content: "save the rows" },
      { id: `${chat}-a1`, role: "assistant", metadata: {
        status: "awaiting_approval",
        parts: [
          { type: "tool-call", id: "s1", name: "save_row", input: { row: "draft" } },
          { type: "tool-result", id: "s1", name: "save_row", output: "saved" },
          { type: "tool-call", id: "s2", name: "save_row", input: { row: "final" }, approval: { id: "ap1", approved: true } },
        ],
        steers: [{ id: "st1", text: steer, at: "2026-10-01T00:00:00Z", atStep: 1, afterToolCallId: "s1" }],
      } },
    ]);
    const msgs = await runTask(`${chat}-task`, chat, { resumeMessageId: `${chat}-a1` });
    for (const id of ["s1", "s2"]) {
      expect(count(msgs, "tool-call", id)).toBe(1);
      expect(count(msgs, "tool-result", id)).toBe(1);
    }
    const text = JSON.stringify(msgs);
    expect(text.split(steer).length - 1).toBe(1);
    expect(text).toContain(REPLY);
  }, 30_000);

  it("after an emergency trim, summarizes the whole history the checkpoint replaces", async () => {
    const chat = `${CX}-trim`;
    const rows = [{ id: `${chat}-u0`, role: "user", content: "Our supplier is Kestrel Ltd." }];
    for (let i = 0; i < 7; i++) {
      rows.push({ id: `${chat}-a${i}`, role: "assistant", content: `Noted ${i}.` });
      rows.push({ id: `${chat}-u${i + 1}`, role: "user", content: `Question ${i + 1}?` });
    }
    await seedPath(chat, rows);
    script.push("overflow");
    const from = prompts.length;
    const msgs = await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u7` });
    // Control: the retry really ran on the trimmed tail, without the oldest turn.
    expect(prompts.length - from).toBe(2);
    expect(JSON.stringify(prompts[from])).toContain("Kestrel");
    expect(JSON.stringify(prompts[from + 1])).not.toContain("Kestrel");
    // The finding: the checkpoint replaces every turn, so the summary must see every turn.
    const text = JSON.stringify(msgs);
    expect(text).toContain("Kestrel");
    expect(text).toContain(REPLY);
  }, 30_000);

  it("recovers from a retry that hits a second limit", async () => {
    const chat = `${CX}-two-limits`;
    await seedPath(chat, [{ id: `${chat}-u1`, role: "user", content: "how many suppliers do we have?" }]);
    script.push("echo", "overflow");
    const from = prompts.length;
    // runTask asserts the turn completed; it used to fail on the overflow.
    await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u1` });
    expect(prompts.length - from).toBe(3);
    const { rows } = await pool.query(`SELECT content FROM messages WHERE chat_id=$1 AND parent_id=$2`, [chat, `${chat}-u1`]);
    expect(rows[0].content).toContain(REPLY);
  }, 30_000);

  it("after an emergency trim, compacts even though the trimmed prompt measured small", async () => {
    const chat = `${CX}-trim-small`;
    await seedPath(chat, [{ id: `${chat}-u1`, role: "user", content: "Our supplier is Kestrel Ltd." }]);
    // Without a checkpoint the next turn sends the same history, overflows and trims again.
    script.push("overflow", answer(Math.ceil(limit * 0.3)));
    const msgs = await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u1` });
    expect(JSON.stringify(msgs)).toContain("Kestrel");
  }, 30_000);

  describe("a summary that lands after the chat moved on", () => {
    afterEach(() => { summarize = undefined; });

    it("with nothing sent meanwhile, becomes the leaf", async () => {
      const chat = `${CX}-quiet`;
      await seedPath(chat, [{ id: `${chat}-u1`, role: "user", content: "how many suppliers do we have?" }]);
      summarize = async () => "Forty-two suppliers.";
      await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u1` });
      await settle();
      const reply = await replyUnder(chat, `${chat}-u1`);
      const [cp, ...more] = await checkpoints(chat);
      expect(more).toHaveLength(0);
      expect(cp.parent_id).toBe(reply);
      expect(await leafOf(chat)).toBe(cp.id);
    }, 30_000);

    it("with a follow-up sent while it ran, still checkpoints, under that follow-up", async () => {
      const chat = `${CX}-race`;
      await seedPath(chat, [{ id: `${chat}-u1`, role: "user", content: "how many suppliers do we have?" }]);
      summarize = async () => {
        await send(chat, `${chat}-m2`, await replyUnder(chat, `${chat}-u1`));
        return "Forty-two suppliers.";
      };
      await runTask(`${chat}-task`, chat, { replyParentId: `${chat}-u1` });
      await settle();
      // The finding: the summary was paid for and then thrown away, because the leaf moved.
      const [cp, ...more] = await checkpoints(chat);
      expect(more).toHaveLength(0);
      expect(cp.parent_id).toBe(await replyUnder(chat, `${chat}-u1`));
      // Spliced between the reply and the follow-up, so the follow-up's path collapses at it.
      expect(await parentOf(`${chat}-m2`)).toBe(cp.id);
      expect(await leafOf(chat)).toBe(`${chat}-m2`);
    }, 30_000);

    it("does not pay for a second summary of the turn that overlapped it", async () => {
      const chat = `${CX}-dedupe`;
      await seedPath(chat, [{ id: `${chat}-u1`, role: "user", content: "how many suppliers do we have?" }]);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      summarize = async () => { await gate; return "Forty-two suppliers."; };
      const before = compacted.length;
      await runTask(`${chat}-task1`, chat, { replyParentId: `${chat}-u1` });
      // The next turn runs while that summary is still being written, and is just as long.
      await send(chat, `${chat}-m2`, await replyUnder(chat, `${chat}-u1`));
      await runTask(`${chat}-task2`, chat, { replyParentId: `${chat}-m2` }, false);
      release();
      await settle();
      expect(compacted.length - before).toBe(1);
      const [cp, ...more] = await checkpoints(chat);
      expect(more).toHaveLength(0);
      expect(await parentOf(`${chat}-m2`)).toBe(cp.id);
    }, 30_000);
  });
});
