import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// The continuation's model and budget hold are not what this suite is about.
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({ isShared: false, modelId: "m", provider: "p", configId: "cfg" }),
}));
vi.mock("@/lib/billing/limits", () => ({
  reserveBudget: async () => ({ allowed: true, window: null, reason: null }),
  releaseHold: async () => {},
}));

import { pool } from "@/lib/db";
import { approveManageForUser } from "../authed";
import { answerAskForUser } from "@/lib/ask/authed";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run decision-leaf.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "dl-user";
const C = "dl-chat";
const form = { fields: [{ id: "q", label: "Which row?", kind: "text" }] };
const waiting = {
  approval: { status: "awaiting_approval", taskId: "dl-t0", parts: [{ type: "tool-call", id: "c1", name: "manage", input: {}, approval: { id: "ap1" } }] },
  ask: { status: "awaiting_answer", taskId: "dl-t0", parts: [{ type: "tool-call", id: "q1", name: "ask", input: {}, answer: { form } }] },
};

/** `dl-u1` → `dl-a1` (the waiting reply) → `dl-u2`, a message the chat went on to. */
async function seed(kind: keyof typeof waiting, leaf: "dl-a1" | "dl-u2") {
  await pool.query(`INSERT INTO messages (id, chat_id, role, content) VALUES ('dl-u1', $1, 'user', 'hi')`, [C]);
  await pool.query(
    `INSERT INTO messages (id, chat_id, parent_id, role, content, metadata) VALUES ('dl-a1', $1, 'dl-u1', 'assistant', '', $2::jsonb)`,
    [C, JSON.stringify(waiting[kind])],
  );
  await pool.query(`INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES ('dl-u2', $1, 'dl-a1', 'user', 'next')`, [C]);
  await pool.query(`UPDATE chats SET active_leaf_id = $2 WHERE id = $1`, [C, leaf]);
}
const stored = async () => (await pool.query(`SELECT metadata FROM messages WHERE id = 'dl-a1'`)).rows[0].metadata;
const resumes = async () => (await pool.query(`SELECT payload->>'resumeMessageId' AS r FROM tasks WHERE chat_id = $1`, [C])).rows.map((x) => x.r);

const decide = {
  approval: () => approveManageForUser(U, { messageId: "dl-a1", toolCallId: "c1", approved: true }),
  ask: () => answerAskForUser(U, { messageId: "dl-a1", toolCallId: "q1", action: "submit", values: { q: "3" } }),
};

run("a decision lands only on the chat's leaf", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'D','dl@test.local') ON CONFLICT DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [C, U]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [C]);
    await pool.query(`UPDATE chats SET active_leaf_id = NULL WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [C]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  for (const kind of ["approval", "ask"] as const) {
    it(`${kind}: refuses a row the chat has moved past, recording nothing and starting no turn`, async () => {
      await seed(kind, "dl-u2");
      expect(await decide[kind]()).toBe("gone");
      expect(await stored()).toEqual(waiting[kind]);
      expect(await resumes()).toEqual([]);
    });

    it(`${kind}: still resumes the row that is the chat's leaf`, async () => {
      await seed(kind, "dl-a1");
      expect(await decide[kind]()).toBe("applied");
      expect(await resumes()).toEqual(["dl-a1"]);
    });
  }

  it("waits out a send that is moving the leaf, then refuses", async () => {
    await seed("approval", "dl-a1");
    const send = await pool.connect();
    try {
      await send.query("BEGIN");
      await send.query(`UPDATE chats SET active_leaf_id = 'dl-u2' WHERE id = $1`, [C]);
      const decision = decide.approval();
      await new Promise((r) => setTimeout(r, 200)); // the decision is now blocked on the chat row
      await send.query("COMMIT");
      expect(await decision).toBe("gone");
    } finally {
      send.release();
    }
    expect(await resumes()).toEqual([]);
  });
});
