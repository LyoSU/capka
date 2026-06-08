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
});
