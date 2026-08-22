import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "../../db";
import { effectsFromParts, recordEffect, loadEffects } from "../effect-ledger";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run effect-ledger.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "eltest-user";
const C = "eltest-chat";
const M = "eltest-message";

run("durable effect ledger", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'E','e@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','',$3)`,
      [M, C, JSON.stringify({ parts: [] })],
    );
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  // The defect this table exists for: an emergency trim clears `parts`, so the row
  // the next task loads no longer mentions a call that already ran. Rebuilding from
  // `parts` therefore reports nothing, and the continuation repeats the write.
  it("still reports a call whose record was dropped from the reply's parts", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "upsert_row", input: { sku: "A-1" } });

    expect(effectsFromParts([])).toEqual([]);
    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "upsert_row", input: { sku: "A-1" } }]);
  });

  it("keeps one row per tool call, so re-running an approved call does not double-count it", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "send_email", input: { to: "a@b.c" } });
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-b", name: "send_email", input: { to: "a@b.c" } });

    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "send_email", input: { to: "a@b.c" } }]);
  });

  it("marks a call that threw, so the note can ask for it to be verified", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "write_file", input: { path: "/x" }, failed: true });

    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "write_file", input: { path: "/x" }, failed: true }]);
  });

  it("keeps the two halves of one message together, in the order they ran", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "first-half", name: "create_row", input: { i: 1 } });
    await recordEffect({ messageId: M, toolCallId: "call-2", taskId: "second-half", name: "create_row", input: { i: 2 } });

    expect((await loadEffects(M)).map((e) => e.input)).toEqual([{ i: 1 }, { i: 2 }]);
  });


  // The runner strips NUL before anything enters `parts`, because Postgres rejects
  // it in jsonb. A model can emit a literal NUL escape inside a valid JSON string
  // argument, so the ledger has to hold the same invariant — otherwise a call that
  // RAN fails to be recorded, which is the one outcome this table exists to prevent.
  it("strips a NUL byte from the recorded input rather than failing the write", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "write_file", input: { path: "/a\u0000b" } });

    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "write_file", input: { path: "/ab" } }]);
  });

  // "It threw" is the conservative reading — a tool that writes before it fails has
  // already written. A later success under the same id must not erase that, or the
  // note stops asking for the one entry that most needs verifying.
  it("keeps a call flagged as failed even when the same call later succeeds", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "upsert_row", input: { sku: "A-1" }, failed: true });
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-b", name: "upsert_row", input: { sku: "A-1" } });

    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "upsert_row", input: { sku: "A-1" }, failed: true }]);
  });

  // The bound this table states for itself: it is per-message, so the row that owns
  // it owns its lifetime too. Without the cascade the ledger would outlive every
  // message it describes and grow without limit.
  it("drops its rows when the message they belong to is deleted", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "upsert_row", input: { sku: "A-1" } });
    await pool.query(`DELETE FROM messages WHERE id = $1`, [M]);

    expect(await loadEffects(M)).toEqual([]);
  });
});
