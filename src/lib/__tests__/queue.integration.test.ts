import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../db";
import {
  enqueueTask,
  claimNextTask,
  heartbeat,
  finalizeTask,
  requestCancel,
  isCancelRequested,
  reconcileZombies,
} from "../tasks/queue";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run queue.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "qtest-user";
const C = "qtest-chat";

run("durable queue", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'Q','q@test.local') ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("claims a queued task atomically and only once", async () => {
    await enqueueTask({ id: "qt1", chatId: C, userId: U, payload: { hello: "world" } });
    const a = await claimNextTask("w1");
    expect(a?.id).toBe("qt1");
    expect(a?.status).toBe("running");
    expect(a?.attempts).toBe(1);
    expect((a?.payload as { hello: string }).hello).toBe("world");

    const b = await claimNextTask("w2"); // nothing left
    expect(b).toBeNull();
  });

  it("heartbeats then finalizes", async () => {
    const ok = await heartbeat("qt1", "w1");
    expect(ok).toBe(true);
    const wrongWorker = await heartbeat("qt1", "someone-else");
    expect(wrongWorker).toBe(false);
    await finalizeTask("qt1", "completed");
    const { rows } = await pool.query(`SELECT status FROM tasks WHERE id='qt1'`);
    expect(rows[0].status).toBe("completed");
  });

  it("requests and reads cancellation", async () => {
    await enqueueTask({ id: "qt2", chatId: C, userId: U, payload: {} });
    expect(await isCancelRequested("qt2")).toBe(false);
    await requestCancel("qt2");
    expect(await isCancelRequested("qt2")).toBe(true);
    // Clear the pending slot on chat C — the one-queued-per-chat index would
    // otherwise make the following tests' enqueues fold into this leftover.
    await finalizeTask("qt2", "cancelled");
  });

  it("keeps at most one pending turn per chat — a second enqueue folds into the first", async () => {
    const cc = "qtest-coalesce";
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [cc, U]);

    const first = await enqueueTask({ id: "qc1", chatId: cc, userId: U, payload: { n: 1 } });
    expect(first).toEqual({ id: "qc1", created: true });

    // A follow-up while one is already pending must NOT create a parallel turn —
    // it folds into the incumbent and reports that incumbent's id so the client
    // tracks a real, cancellable turn.
    const second = await enqueueTask({ id: "qc2", chatId: cc, userId: U, payload: { n: 2 } });
    expect(second).toEqual({ id: "qc1", created: false });

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE chat_id = $1 AND status = 'queued'`,
      [cc],
    );
    expect(rows[0].n).toBe(1);

    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [cc]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [cc]);
  });

  it("allows a fresh continuation once the running turn frees the slot", async () => {
    const cc = "qtest-continuation";
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [cc, U]);

    await enqueueTask({ id: "qk1", chatId: cc, userId: U, payload: {} });
    // Move it out of 'queued' (as claimNextTask would) so the partial index no
    // longer constrains the chat — a queued continuation can now sit behind it.
    await pool.query(
      `UPDATE tasks SET status='running', lease_expires_at = now() + interval '1 minute' WHERE id='qk1'`,
    );

    const cont = await enqueueTask({ id: "qk2", chatId: cc, userId: U, payload: {} });
    expect(cont).toEqual({ id: "qk2", created: true });

    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [cc]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [cc]);
  });

  it("reconciles zombies whose lease expired", async () => {
    await enqueueTask({ id: "qt3", chatId: C, userId: U, payload: {} });
    // Simulate a worker that claimed it then died: running with an expired lease.
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() - interval '1 minute' WHERE id='qt3'`,
    );
    const reconciled = await reconcileZombies();
    expect(reconciled.some((r) => r.id === "qt3")).toBe(true);
    const { rows } = await pool.query(`SELECT status, error FROM tasks WHERE id='qt3'`);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/lease expired/);
  });

  it("reconciles the abandoned assistant message, not just the task", async () => {
    await enqueueTask({ id: "qt4", chatId: C, userId: U, payload: {} });
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() - interval '1 minute' WHERE id='qt4'`,
    );
    // The worker wrote a placeholder assistant row, then died before finishing.
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','',$3)`,
      ["qmsg4", C, JSON.stringify({ taskId: "qt4", status: "running", parts: [] })],
    );

    await reconcileZombies();

    const { rows } = await pool.query<{ metadata: { status: string; error?: string; taskId: string; parts: unknown[] } }>(
      `SELECT metadata FROM messages WHERE id='qmsg4'`,
    );
    // The message must no longer read as "running" — otherwise the client revives
    // a stuck spinner on every history reload.
    expect(rows[0].metadata.status).toBe("failed");
    expect(rows[0].metadata.error).toBeTruthy();
    // Existing fields (parts, taskId) are preserved, not clobbered.
    expect(rows[0].metadata.parts).toEqual([]);
    expect(rows[0].metadata.taskId).toBe("qt4");
  });

  // H10 + M10: reconcileZombies must settle outstanding holds, not just tasks —
  // both the ones it reaps this run AND any orphaned hold whose owning task is
  // already terminal (a crash between finalize and reconcile, or a swallowed
  // releaseHold). Otherwise a stale estimate inflates the budget until 30 days.
  it("settles pending holds: freshly-reaped zombies and already-terminal orphans", async () => {
    // A zombie: running with an expired lease + an outstanding pending hold.
    await enqueueTask({ id: "qz1", chatId: C, userId: U, payload: {} });
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() - interval '1 minute' WHERE id='qz1'`,
    );
    await pool.query(
      `INSERT INTO usage (id, task_id, user_id, provider, model, cost_usd, on_shared_key, pending)
       VALUES ('uz1','qz1',$1,'shared','m','0.01',true,true)`,
      [U],
    );
    // An orphan: a task already flipped to completed but whose hold was never
    // settled (H5 crash window / swallowed releaseHold).
    await enqueueTask({ id: "qz2", chatId: "qz2-chat", userId: U, payload: {} });
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ('qz2-chat',$1) ON CONFLICT (id) DO NOTHING`, [U]);
    await pool.query(`UPDATE tasks SET status='completed' WHERE id='qz2'`);
    await pool.query(
      `INSERT INTO usage (id, task_id, user_id, provider, model, cost_usd, on_shared_key, pending)
       VALUES ('uz2','qz2',$1,'shared','m','0.02',true,true)`,
      [U],
    );

    await reconcileZombies();

    const { rows } = await pool.query<{ task_id: string }>(
      `SELECT task_id FROM usage WHERE task_id IN ('qz1','qz2') AND pending = true`,
    );
    // Both stale holds are gone — neither the reaped zombie nor the terminal
    // orphan keeps a pending estimate.
    expect(rows.length).toBe(0);

    await pool.query(`DELETE FROM usage WHERE task_id IN ('qz1','qz2')`);
    await pool.query(`DELETE FROM tasks WHERE id IN ('qz1','qz2')`);
    await pool.query(`DELETE FROM chats WHERE id = 'qz2-chat'`);
  });

  it("leaves messages of healthy tasks untouched", async () => {
    await enqueueTask({ id: "qt5", chatId: C, userId: U, payload: {} });
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() + interval '1 minute' WHERE id='qt5'`,
    );
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','',$3)`,
      ["qmsg5", C, JSON.stringify({ taskId: "qt5", status: "running", parts: [] })],
    );

    await reconcileZombies();

    const { rows } = await pool.query<{ metadata: { status: string } }>(
      `SELECT metadata FROM messages WHERE id='qmsg5'`,
    );
    expect(rows[0].metadata.status).toBe("running");
  });
});
