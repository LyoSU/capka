import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { pool } from "../../db";
import { appendSteer, readSteers, STEER_MAX_PER_TURN } from "../queue";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run steer.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "steertest-user";
const OTHER = "steertest-other";
const C = "steertest-chat";
const T = "steertest-task";
// A permanently-"running" row in the same chat, inserted once and never claimed.
// The live worker in this process polls for real work, and `claimNextTask` skips a
// workspace that already has a running turn — so this is what stops it from picking
// up the QUEUED fixture below and running a turn against a bogus chat. Its lease is
// NULL, which also keeps `reconcileZombies` (lease_expires_at < now()) off it.
const BLOCKER = "steertest-blocker";

const steer = (id: string) => ({ id, text: `note ${id}`, at: new Date().toISOString() });
const insertTask = (status: string) =>
  pool.query(
    `INSERT INTO tasks (id, chat_id, user_id, status) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, steers = '[]'::jsonb`,
    [T, C, U, status],
  );

run("steering a running turn", () => {
  beforeAll(async () => {
    for (const id of [U, OTHER]) {
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'S',$2) ON CONFLICT (id) DO NOTHING`, [id, `${id}@test.local`]);
    }
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [C, U]);
    await pool.query(
      `INSERT INTO tasks (id, chat_id, user_id, status) VALUES ($1,$2,$3,'running') ON CONFLICT (id) DO NOTHING`,
      [BLOCKER, C, U],
    );
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1 AND id <> $2`, [C, BLOCKER]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE chat_id = $1`, [C]);
    await pool.query(`DELETE FROM chats WHERE id = $1`, [C]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[U, OTHER]]);
  });

  it("starts every turn with an empty array, so the runner's read needs no coalesce", async () => {
    await insertTask("running");
    expect(await readSteers(T)).toEqual([]);
  });

  it("appends to a running turn, oldest first", async () => {
    await insertTask("running");
    expect(await appendSteer(T, U, steer("s1"))).toBe("ok");
    expect(await appendSteer(T, U, steer("s2"))).toBe("ok");
    expect((await readSteers(T)).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  // The outcome the client acts on: the turn can no longer read it, so the message
  // has to be sent the ordinary way instead of vanishing into a finished row.
  it("reports tooLate for a turn that is not running", async () => {
    for (const status of ["queued", "completed", "failed", "cancelled"]) {
      await insertTask(status);
      expect(await appendSteer(T, U, steer("s1"))).toBe("tooLate");
      expect(await readSteers(T)).toEqual([]);
    }
  });

  it("reports tooLate for a task that does not exist", async () => {
    expect(await appendSteer("steertest-nope", U, steer("s1"))).toBe("tooLate");
  });

  // Ownership is in the UPDATE's own WHERE, not only in the route's lookup — a task
  // id is guessable enough that the write itself has to refuse.
  it("refuses another user's turn without touching it", async () => {
    await insertTask("running");
    expect(await appendSteer(T, OTHER, steer("s1"))).toBe("tooLate");
    expect(await readSteers(T)).toEqual([]);
  });

  it("caps one turn's steers and says so distinctly from a finished turn", async () => {
    await insertTask("running");
    for (let i = 0; i < STEER_MAX_PER_TURN; i++) {
      expect(await appendSteer(T, U, steer(`s${i}`))).toBe("ok");
    }
    expect(await appendSteer(T, U, steer("over"))).toBe("tooMany");
    expect(await readSteers(T)).toHaveLength(STEER_MAX_PER_TURN);
  });

  // `steers || $1::jsonb` is an atomic append; a read-modify-write here would lose
  // one of two steers sent from two tabs at the same instant.
  it("keeps every steer when several land at once", async () => {
    await insertTask("running");
    await Promise.all([1, 2, 3, 4, 5].map((n) => appendSteer(T, U, steer(`c${n}`))));
    expect((await readSteers(T)).map((s) => s.id).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });
});
