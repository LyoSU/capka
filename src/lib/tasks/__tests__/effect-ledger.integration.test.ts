import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "../../db";
import { effectsFromParts, recordEffect, recordEffectStarted, loadEffects, withEffectLedger, loadInheritedEffects, EffectLedgerError } from "../effect-ledger";

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

  // Write-ahead. A row written only on the result cannot describe the window the
  // ledger most needs to cover: the tool was entered, the worker died, and nothing
  // anywhere says the workspace may have been touched. So the row goes in BEFORE
  // execute, and until an outcome arrives it claims uncertainty rather than work.
  it("records a call at dispatch, before any outcome is known", async () => {
    await recordEffectStarted({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "send_email", input: { to: "a@b.c" } });

    expect(await loadEffects(M)).toEqual([
      { id: "call-1", name: "send_email", input: { to: "a@b.c" }, unsettled: true },
    ]);
  });

  it("settles the dispatch row when the outcome arrives, instead of adding a second one", async () => {
    await recordEffectStarted({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "send_email", input: { to: "a@b.c" } });
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "send_email", input: { to: "a@b.c" } });

    expect(await loadEffects(M)).toEqual([{ id: "call-1", name: "send_email", input: { to: "a@b.c" } }]);
  });

  // The mirror of sticky `failed`, and for the same reason: once an outcome is known
  // it is the stronger statement, and a re-approved call re-entering execute must not
  // downgrade "this ran" back to "this might have run".
  it("keeps a settled call settled when the same call is dispatched again", async () => {
    await recordEffect({ messageId: M, toolCallId: "call-1", taskId: "task-a", name: "upsert_row", input: { sku: "A-1" } });
    await recordEffectStarted({ messageId: M, toolCallId: "call-1", taskId: "task-b", name: "upsert_row", input: { sku: "A-1" } });

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

  // Write-ahead is only write-AHEAD if the row is durable before the tool body can
  // touch anything. Asserting the row merely EXISTS afterwards would pass just as well
  // for a write that landed second, which is the bug. So the tool body reads the ledger
  // itself: the assertion is the ordering.
  it("has the row on disk before the tool body can run", async () => {
    let seenByTool: Awaited<ReturnType<typeof loadEffects>> = [];
    const tools = withEffectLedger(
      { send_email: { description: "d", execute: async (...args: unknown[]) => { void args; seenByTool = await loadEffects(M); return "sent"; } } },
      { messageId: M, taskId: "task-a" },
    );

    const out = await tools.send_email.execute!({ to: "a@b.c" }, { toolCallId: "call-1" });

    expect(out).toBe("sent");
    expect(seenByTool).toEqual([{ id: "call-1", name: "send_email", input: { to: "a@b.c" }, unsettled: true }]);
  });

  // Fail CLOSED. The AI SDK's own pre-execution callback cannot do this job: it is
  // invoked through `notify()`, which swallows callback errors, so a lost ledger write
  // there would let the tool run unrecorded — the original defect in a smaller window.
  it("refuses to run the tool at all when the dispatch write cannot land", async () => {
    let ran = false;
    const tools = withEffectLedger(
      { send_email: { execute: async (...args: unknown[]) => { void args; ran = true; return "sent"; } } },
      { messageId: "no-such-message-row", taskId: "task-a" },
    );

    await expect(tools.send_email.execute!({ to: "a@b.c" }, { toolCallId: "call-1" }))
      .rejects.toThrow(EffectLedgerError);
    expect(ran).toBe(false);
  });

  // `ask` is a no-execute tool BY DESIGN: the SDK ends the tool loop when the model
  // calls it, which the runner turns into a durable "awaiting_answer" suspend. Giving
  // it an execute would silently convert a suspend into a call. Provider-executed tools
  // (Gemini's grounding) have no local execute either, for a different reason and with
  // the same consequence.
  it("leaves a no-execute tool exactly as it was", () => {
    const ask = { description: "ask the human" };
    const tools = withEffectLedger({ ask }, { messageId: M, taskId: "task-a" });

    expect(tools.ask).toBe(ask);
    expect("execute" in tools.ask).toBe(false);
  });

  // The "Continue" button is not a continuation in the runner's sense: it sends an
  // ordinary user message, so the new turn gets a fresh message id and the ledger it
  // needs belongs to the PREVIOUS, failed reply. These pin the walk that finds it.
  describe("inheriting the effects of a reply that failed part-way", () => {
    /** Chain a message onto `parent`, returning its id. */
    const put = async (id: string, role: string, parent: string | null, meta: object) => {
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, parent_id, metadata) VALUES ($1,$2,$3,'',$4,$5)`,
        [id, C, role, parent, JSON.stringify(meta)],
      );
      return id;
    };
    const partial = { status: "failed", errorCategory: "timed_out_partial", parts: [] };
    const ok = { status: "completed", parts: [] };

    it("hands the previous reply's executed calls to the turn that continues it", async () => {
      const a0 = await put("inh-a0", "assistant", null, partial);
      await recordEffect({ messageId: a0, toolCallId: "c1", taskId: "t0", name: "upsert_row", input: { sku: "A-1" } });
      const u1 = await put("inh-u1", "user", a0, {});

      expect(await loadInheritedEffects(u1)).toEqual([
        { id: "c1", name: "upsert_row", input: { sku: "A-1" } },
      ]);
    });

    // A second Continue that also fails must not forget the first one's writes: the
    // effects it has to warn about are spread over two replies by then.
    it("walks a chain of consecutive part-way failures, oldest first", async () => {
      const a0 = await put("inh2-a0", "assistant", null, partial);
      await recordEffect({ messageId: a0, toolCallId: "c1", taskId: "t0", name: "create_row", input: { i: 1 } });
      const u1 = await put("inh2-u1", "user", a0, {});
      const a1 = await put("inh2-a1", "assistant", u1, partial);
      await recordEffect({ messageId: a1, toolCallId: "c2", taskId: "t1", name: "create_row", input: { i: 2 } });
      const u2 = await put("inh2-u2", "user", a1, {});

      expect((await loadInheritedEffects(u2)).map((e) => e.input)).toEqual([{ i: 1 }, { i: 2 }]);
    });

    // A reply that COMPLETED is the baseline: whatever came before it was already
    // accounted for by the turn that succeeded, so the walk stops there rather than
    // dragging a whole chat's history into the note.
    it("stops at a reply that completed", async () => {
      const a0 = await put("inh3-a0", "assistant", null, partial);
      await recordEffect({ messageId: a0, toolCallId: "c1", taskId: "t0", name: "old_write", input: { i: 0 } });
      const u1 = await put("inh3-u1", "user", a0, {});
      const a1 = await put("inh3-a1", "assistant", u1, ok);
      const u2 = await put("inh3-u2", "user", a1, {});

      expect(await loadInheritedEffects(u2)).toEqual([]);
    });

    it("says nothing when the previous reply succeeded", async () => {
      const a0 = await put("inh4-a0", "assistant", null, ok);
      await recordEffect({ messageId: a0, toolCallId: "c1", taskId: "t0", name: "w", input: {} });
      const u1 = await put("inh4-u1", "user", a0, {});

      expect(await loadInheritedEffects(u1)).toEqual([]);
    });
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
