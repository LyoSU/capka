import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "../../db";
import { claimFinishedJobs, dispatchChat, JOB_FOLLOWUP_CHAIN_MAX } from "../background-jobs";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run background-jobs.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "bgjobtest-user";
const C = "bgjobtest-chat";
// Past the bound, so no follow-up turn (and no model/budget lookup) is involved: what
// is under test is the claim itself, which is the same code either way.
const OVER = JOB_FOLLOWUP_CHAIN_MAX;
const finished = (id: string) =>
  pool.query(
    `INSERT INTO background_jobs (id, chat_id, user_id, session_key, job_id, command, chain, status, result)
     VALUES ($1,$2,$3,'s',$1,'make',$4,'finished','{"outcome":"done","exitCode":0}'::jsonb)`,
    [id, C, U, OVER],
  );
const notices = async () =>
  (await pool.query(`SELECT id FROM messages WHERE chat_id = $1 AND platform = 'job'`, [C])).rows.length;

run("background job notices are delivered exactly once", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'B',$2) ON CONFLICT (id) DO NOTHING`, [U, `${U}@test.local`]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM background_jobs WHERE chat_id = $1`, [C]);
    await pool.query(`UPDATE chats SET active_leaf_id = NULL WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM messages WHERE chat_id = $1`, [C]);
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [C]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  it("two concurrent dispatches write one notice for both jobs, and queue no turn past the bound", async () => {
    await finished("bgj-a");
    await finished("bgj-b");
    await Promise.all([dispatchChat(C), dispatchChat(C)]);
    expect(await notices()).toBe(1);
    const { rows } = await pool.query(`SELECT status FROM background_jobs WHERE chat_id = $1`, [C]);
    expect(rows.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    expect((await pool.query(`SELECT id FROM tasks WHERE chat_id = $1`, [C])).rows).toHaveLength(0);
    // The notice is the chat's new leaf, not a dangling branch.
    const leaf = await pool.query(`SELECT m.platform FROM chats c JOIN messages m ON m.id = c.active_leaf_id WHERE c.id = $1`, [C]);
    expect(leaf.rows[0].platform).toBe("job");
  });

  it("leaves the notice to a turn already live in the chat, which claims it once", async () => {
    await finished("bgj-c");
    await pool.query(`INSERT INTO tasks (id, chat_id, user_id, status) VALUES ('bgj-live',$1,$2,'running')`, [C, U]);
    await dispatchChat(C);
    expect(await notices()).toBe(0);
    expect((await claimFinishedJobs(C)).map((r) => r.jobId)).toEqual(["bgj-c"]);
    expect(await claimFinishedJobs(C)).toEqual([]);
  });
});
