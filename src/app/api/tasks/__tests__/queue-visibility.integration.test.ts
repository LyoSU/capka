import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run queue-visibility.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "tasks-queue-test-user";
const C = "tasks-queue-test-chat";

const { requireSession, requireRole } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession, requireRole };
});
// The event is the only thing that tells an open client a turn it is watching has
// stopped existing, so its absence is a real defect — assert on it rather than on
// the realtime transport underneath.
const { publishTaskEvent } = vi.hoisted(() => ({ publishTaskEvent: vi.fn() }));
vi.mock("@/lib/tasks/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks/events")>();
  return { ...actual, publishTaskEvent };
});

type Probe = {
  id: string;
  status: string;
  queued: { id: string; createdAt: string | null; platform: string } | null;
} | null;

run("the chat's live turn and the follow-up behind it", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1,'Q','tasks-queue@test.local') ON CONFLICT (id) DO NOTHING`,
      [U],
    );
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`, [C, U]);
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM usage WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM tasks WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
    requireRole.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
  });

  /**
   * A task `secondsAgo` old. A RUNNING row is given a live lease deliberately:
   * `claimNextTask` refuses a workspace that already holds one, which is what keeps
   * the dev container's live worker from claiming the queued rows these assertions
   * are about (a claim would flip the very status under test).
   */
  async function task(id: string, status: string, secondsAgo: number) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO tasks (id, chat_id, user_id, status, lease_expires_at, created_at)
       VALUES ($1,$2,$3,$4,
               CASE WHEN $4 = 'running' THEN now() + interval '5 minutes' END,
               now() - ($5 || ' seconds')::interval)`,
      [id, C, U, status, String(secondsAgo)],
    );
  }

  async function userMessage(id: string, platform: string) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, platform) VALUES ($1,$2,'user','hi',$3)`,
      [id, C, platform],
    );
  }

  /** The pending budget hold `enqueueTask`'s callers reserve for a queued turn. */
  async function hold(taskId: string) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO usage (id, task_id, user_id, provider, model, cost_usd, pending, on_shared_key)
       VALUES ($1,$1,$2,'test','test-model',0.01,true,true)`,
      [taskId, U],
    );
  }

  async function probe(): Promise<Probe> {
    const { GET } = await import("../route");
    const res = await GET(new Request(`http://x/api/tasks?chatId=${C}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Probe;
  }

  async function cancel(id: string) {
    const { POST } = await import("../[id]/cancel/route");
    return POST(new Request(`http://x/api/tasks/${id}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id }),
    });
  }

  // The defect: ordering by created_at alone made the newer QUEUED follow-up the
  // chat's answer, so the web Stop flagged a turn that had not started (the reply
  // kept streaming) and steer() saw a non-running task and queued instead.
  it("reports the RUNNING turn even when a newer follow-up is queued behind it", async () => {
    await task("tq-running", "running", 120);
    await task("tq-queued", "queued", 1);
    await userMessage("tq-msg", "telegram");

    const p = await probe();
    expect(p?.id).toBe("tq-running");
    expect(p?.status).toBe("running");
    expect(p?.queued?.id).toBe("tq-queued");
    // Where it came from — the platform of the newest user message it will answer.
    expect(p?.queued?.platform).toBe("telegram");
  });

  it("falls back to the latest row when nothing is running, and reports no follow-up", async () => {
    await task("tq-old", "completed", 300);
    await task("tq-new", "failed", 10);

    const p = await probe();
    expect(p?.id).toBe("tq-new");
    expect(p?.queued).toBeNull();
  });

  it("removes a cancelled queued turn immediately, with its hold and a finish event", async () => {
    await task("tq-running-2", "running", 120);
    await task("tq-drop", "queued", 1);
    await hold("tq-drop");

    const res = await cancel("tq-drop");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "removed" });

    const { pool } = await import("@/lib/db");
    // Gone now — not "flagged and finalized whenever the running reply ends".
    const rows = await pool.query(`SELECT id FROM tasks WHERE id = $1`, ["tq-drop"]);
    expect(rows.rowCount).toBe(0);
    // Nothing can attribute a hold whose task row is gone, so the delete had to
    // take it with it or it would erode the user's budget for 30 days.
    const holds = await pool.query(`SELECT id FROM usage WHERE task_id = $1 AND pending = true`, ["tq-drop"]);
    expect(holds.rowCount).toBe(0);
    expect(publishTaskEvent).toHaveBeenCalledWith(U, {
      type: "task:finish",
      taskId: "tq-drop",
      chatId: C,
      status: "cancelled",
    });

    // And the follow-up is no longer reported as waiting.
    expect((await probe())?.queued).toBeNull();
  });

  it("leaves a running turn to stop cooperatively", async () => {
    await task("tq-stop", "running", 30);

    const res = await cancel("tq-stop");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { pool } = await import("@/lib/db");
    const { rows } = await pool.query<{ status: string; cancel_requested: boolean }>(
      `SELECT status, cancel_requested FROM tasks WHERE id = $1`,
      ["tq-stop"],
    );
    // The row must survive: its worker owns the outcome and the reply row.
    expect(rows[0].status).toBe("running");
    expect(rows[0].cancel_requested).toBe(true);
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });
});
