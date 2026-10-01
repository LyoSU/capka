import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { db, pool } from "@/lib/db";
import { settleMovedPast } from "../queue";
import { UNDECIDED_APPROVAL_REASON } from "@/lib/chat/tool-results";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run settle-moved-past.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "smp-user";
const C = "smp-chat";
const form = { fields: [{ id: "row", label: "Which row?", kind: "text" }] };
const undecided = { type: "tool-call", id: "c1", name: "save_row", input: {}, approval: { id: "ap1" } };
const unanswered = { type: "tool-call", id: "q1", name: "ask", input: {}, answer: { form } };

async function seed(metadata: Record<string, unknown>) {
  await pool.query(`INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ('smp-a1', $1, 'assistant', '', $2::jsonb)`, [C, JSON.stringify(metadata)]);
}
const stored = async () => (await pool.query(`SELECT metadata FROM messages WHERE id = 'smp-a1'`)).rows[0].metadata;

/** approveManageForUser's own compare-and-set: it lands only while a call is undecided. */
const decide = (exec: typeof pool | { query: typeof pool.query }) => exec.query(
  `UPDATE messages SET metadata = jsonb_set(metadata, '{parts,0,approval,approved}', 'true')
    WHERE id = 'smp-a1' AND metadata @? '$.parts[*] ? (exists(@.approval) && !exists(@.approval.approved))'`);

run("settleMovedPast", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'S','smp@test.local') ON CONFLICT DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [C, U]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("declines an undecided approval and stops the row waiting", async () => {
    await seed({ status: "awaiting_approval", taskId: "t1", parts: [{ type: "text", text: "Saving." }, undecided] });
    await settleMovedPast("smp-a1");
    expect(await stored()).toEqual({
      status: "completed", taskId: "t1",
      parts: [{ type: "text", text: "Saving." }, { ...undecided, approval: { id: "ap1", approved: false, reason: UNDECIDED_APPROVAL_REASON } }],
    });
  });

  it("skips an unanswered ask with the result an explicit Skip stores", async () => {
    await seed({ status: "awaiting_answer", parts: [unanswered] });
    await settleMovedPast("smp-a1");
    const skip = { action: "skip", values: {} };
    expect(await stored()).toEqual({
      status: "completed",
      parts: [{ ...unanswered, answer: { form, value: skip } }, { type: "tool-result", id: "q1", name: "ask", output: skip }],
    });
  });

  it("leaves a row whose decision already landed to the continuation that owns it", async () => {
    const decided = { status: "awaiting_approval", parts: [{ ...undecided, approval: { id: "ap1", approved: true } }] };
    await seed(decided);
    await settleMovedPast("smp-a1");
    expect(await stored()).toEqual(decided);
  });

  it("touches a finished row not at all", async () => {
    const done = { status: "completed", parts: [{ type: "text", text: "Done." }] };
    await seed(done);
    await settleMovedPast("smp-a1");
    expect(await stored()).toEqual(done);
  });

  // The admission and a tap on the card, at the same moment. Whichever commits first
  // wins; the other must not overwrite it.
  it("lets a decision that commits first stand", async () => {
    await seed({ status: "awaiting_approval", parts: [undecided] });
    const tap = await pool.connect();
    try {
      await tap.query("BEGIN");
      expect((await decide(tap)).rowCount).toBe(1);
      // Blocks on the tap's row lock; its compare-and-set then misses and re-reads.
      const settling = settleMovedPast("smp-a1");
      await new Promise((r) => setTimeout(r, 200));
      await tap.query("COMMIT");
      await settling;
    } finally {
      tap.release();
    }
    expect(await stored()).toMatchObject({ status: "awaiting_approval", parts: [{ approval: { id: "ap1", approved: true } }] });
  });

  it("refuses a decision that arrives after the settle", async () => {
    await seed({ status: "awaiting_approval", parts: [undecided] });
    let tapping: ReturnType<typeof decide> | undefined;
    await db.transaction(async (tx) => {
      await settleMovedPast("smp-a1", tx);
      // Still inside the admission: the tap waits for it, then finds nothing undecided.
      tapping = decide(pool);
      await new Promise((r) => setTimeout(r, 200));
    });
    expect((await tapping!).rowCount).toBe(0);
    expect(await stored()).toMatchObject({ status: "completed", parts: [{ approval: { approved: false } }] });
  });
});
