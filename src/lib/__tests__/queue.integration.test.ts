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
  commitTurnOutcome,
} from "../tasks/queue";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run queue.integration
//
// `claimNextTask` takes the oldest queued row in the WHOLE table — it's a worker,
// not a per-user query — so these assertions hold only while nothing else has a
// task queued. That's why `test:integration:db` runs with --no-file-parallelism:
// scheduler.integration fires a real automation, and its nanoid task sat in the
// queue long enough for this file's claims to pick it up instead.
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

  it("serializes different chats that share one project workspace", async () => {
    const projectId = "qtest-project";
    const chats = ["qtest-project-chat-a", "qtest-project-chat-b"];
    await pool.query(
      `INSERT INTO projects (id, user_id, name) VALUES ($1,$2,'Queue project') ON CONFLICT (id) DO NOTHING`,
      [projectId, U],
    );
    for (const chatId of chats) {
      await pool.query(
        `INSERT INTO chats (id, user_id, project_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [chatId, U, projectId],
      );
    }
    try {
      await enqueueTask({ id: "qp1", chatId: chats[0], userId: U, payload: {} });
      await enqueueTask({ id: "qp2", chatId: chats[1], userId: U, payload: {} });

      const first = await claimNextTask("workspace-worker-1");
      expect(first?.id).toBe("qp1");
      expect(await claimNextTask("workspace-worker-2")).toBeNull();

      await finalizeTask("qp1", "completed");
      expect((await claimNextTask("workspace-worker-2"))?.id).toBe("qp2");
    } finally {
      await pool.query(`DELETE FROM tasks WHERE chat_id = ANY($1::text[])`, [chats]);
      await pool.query(`DELETE FROM chats WHERE id = ANY($1::text[])`, [chats]);
      await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
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

  it("refuses to renew an EXPIRED lease — a frozen worker must stand down, not resurrect", async () => {
    // The moment a lease lapses, claimNextTask lets another worker start a turn in
    // the same workspace. A worker that stalled past expiry and then heartbeated
    // successfully would revoke that exclusion after the fact, putting two turns in
    // one workspace. Simulate the stall by backdating the lease.
    await enqueueTask({ id: "qt-lease", chatId: C, userId: U, payload: {} });
    const claimed = await claimNextTask("frozen-worker");
    expect(claimed?.id).toBe("qt-lease");
    expect(await heartbeat("qt-lease", "frozen-worker")).toBe(true);

    await pool.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = 'qt-lease'`);
    expect(await heartbeat("qt-lease", "frozen-worker")).toBe(false);
    // …and the refusal must not have quietly extended it anyway.
    const { rows } = await pool.query(`SELECT lease_expires_at < now() AS expired FROM tasks WHERE id='qt-lease'`);
    expect(rows[0].expired).toBe(true);
    await finalizeTask("qt-lease", "failed");
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

  it("first terminal status wins: a reaped worker cannot revive its task", async () => {
    await enqueueTask({ id: "qt3b", chatId: C, userId: U, payload: {} });
    await pool.query(`UPDATE tasks SET status='running', worker_id='w1' WHERE id='qt3b'`);

    // The run that owns the row settles it.
    expect(await finalizeTask("qt3b", "completed", null, "w1")).toBe(true);
    // Anything arriving afterwards loses, whoever it is.
    expect(await finalizeTask("qt3b", "failed", "too late", "w1")).toBe(false);
    const { rows } = await pool.query(`SELECT status, error FROM tasks WHERE id='qt3b'`);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].error).toBeNull();
  });

  it("a worker cannot settle a task that is no longer its own", async () => {
    await enqueueTask({ id: "qt3c", chatId: C, userId: U, payload: {} });
    await pool.query(`UPDATE tasks SET status='running', worker_id='w1' WHERE id='qt3c'`);

    expect(await finalizeTask("qt3c", "completed", null, "someone-else")).toBe(false);
    const { rows } = await pool.query(`SELECT status FROM tasks WHERE id='qt3c'`);
    expect(rows[0].status).toBe("running");
  });

  it("a reaped run's outcome commit takes neither the task nor the message", async () => {
    // The race this whole guard exists for: the reconciler declares the turn
    // interrupted and rewrites the assistant message, THEN the stalled worker wakes
    // up with a finished answer. Guarding only the task row let it rewrite the
    // message and push the answer out, so the user still saw "interrupted" flip to a
    // real reply. Both writes must fall together.
    await enqueueTask({ id: "qt3d", chatId: C, userId: U, payload: {} });
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() - interval '1 minute' WHERE id='qt3d'`,
    );
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','',$3)`,
      ["qmsg3d", C, JSON.stringify({ taskId: "qt3d", status: "running", parts: [] })],
    );

    await reconcileZombies();

    const committed = await commitTurnOutcome({
      taskId: "qt3d", workerId: "w1", status: "completed", error: null,
      message: { id: "qmsg3d", content: "the answer the user must not see now", metadata: { taskId: "qt3d", status: "completed" } },
    });

    expect(committed).toBe(false);
    const task = await pool.query(`SELECT status FROM tasks WHERE id='qt3d'`);
    expect(task.rows[0].status).toBe("failed");
    const msg = await pool.query<{ content: string; metadata: { status: string } }>(
      `SELECT content, metadata FROM messages WHERE id='qmsg3d'`,
    );
    expect(msg.rows[0].metadata.status).toBe("failed");
    expect(msg.rows[0].content).toBe("");
  });

  it("a lost CAS leaves no orphan message behind for a failure that never got one", async () => {
    // The setup-failure shape: prepareRun threw before the assistant row existed, so
    // the outcome commit has to INSERT it. If it loses the race, the insert and the
    // chat's leaf move must fall with it — otherwise a turn the reconciler already
    // called interrupted grows a second, contradicting message.
    await enqueueTask({ id: "qt3e", chatId: C, userId: U, payload: {} });
    await pool.query(
      `UPDATE tasks SET status='running', worker_id='w1', lease_expires_at = now() - interval '1 minute' WHERE id='qt3e'`,
    );
    const leafBefore = (await pool.query<{ active_leaf_id: string | null }>(
      `SELECT active_leaf_id FROM chats WHERE id=$1`, [C],
    )).rows[0].active_leaf_id;

    await reconcileZombies();

    const committed = await commitTurnOutcome({
      taskId: "qt3e", workerId: "w1", status: "failed", error: "provider gone",
      message: {
        id: "qmsg3e", content: "a failure notice that must not appear", metadata: { taskId: "qt3e", status: "failed" },
        insert: { chatId: C, parentId: null, platform: "web" },
      },
    });

    expect(committed).toBe(false);
    const msg = await pool.query(`SELECT id FROM messages WHERE id='qmsg3e'`);
    expect(msg.rowCount).toBe(0);
    const leafAfter = (await pool.query<{ active_leaf_id: string | null }>(
      `SELECT active_leaf_id FROM chats WHERE id=$1`, [C],
    )).rows[0].active_leaf_id;
    expect(leafAfter).toBe(leafBefore);
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
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ('qz2-chat',$1) ON CONFLICT (id) DO NOTHING`, [U]);
    await enqueueTask({ id: "qz2", chatId: "qz2-chat", userId: U, payload: {} });
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

  it("reconciles a stuck 'running' message whose task already reached a terminal status", async () => {
    // Failure-path repair: finalizeTask flipped the task to 'failed' but the message
    // UPDATE was lost (swallowed .catch), leaving the message stuck at 'running'. The
    // task is NOT a lease-expired zombie — it's already terminal — so the dead-CTE
    // never sees it. This must still clear the stuck spinner on the next sweep.
    await enqueueTask({ id: "qt6", chatId: C, userId: U, payload: {} });
    await pool.query(`UPDATE tasks SET status='failed', error='boom' WHERE id='qt6'`);
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','partial',$3)`,
      ["qmsg6", C, JSON.stringify({ taskId: "qt6", status: "running", parts: [] })],
    );

    await reconcileZombies();

    const { rows } = await pool.query<{ metadata: { status: string; taskId: string; parts: unknown[] } }>(
      `SELECT metadata FROM messages WHERE id='qmsg6'`,
    );
    expect(rows[0].metadata.status).not.toBe("running");
    // Existing fields preserved.
    expect(rows[0].metadata.parts).toEqual([]);
    expect(rows[0].metadata.taskId).toBe("qt6");
  });

  it("leaves a completed task's message alone (never rewrites a real answer to interrupted)", async () => {
    await enqueueTask({ id: "qt7", chatId: C, userId: U, payload: {} });
    await pool.query(`UPDATE tasks SET status='completed' WHERE id='qt7'`);
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, metadata) VALUES ($1,$2,'assistant','the answer',$3)`,
      ["qmsg7", C, JSON.stringify({ taskId: "qt7", status: "completed", parts: [] })],
    );

    await reconcileZombies();

    const { rows } = await pool.query<{ metadata: { status: string } }>(
      `SELECT metadata FROM messages WHERE id='qmsg7'`,
    );
    expect(rows[0].metadata.status).toBe("completed");
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
