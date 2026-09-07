import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run attention.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "attention-test-user";

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});

type Row = {
  id: string;
  attention: { kind: string; since: string } | null;
};

run("GET /api/chats attention", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1,'A','attention@test.local') ON CONFLICT (id) DO NOTHING`,
      [U],
    );
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [U]);
  });

  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = $1`, [U]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
  });

  /** A chat whose updated_at is `n` minutes ago, so the ordering is deterministic. */
  async function chat(id: string, opts: { archived?: boolean; minutesAgo?: number } = {}) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO chats (id, user_id, title, archived, updated_at)
       VALUES ($1,$2,$1,$3, now() - ($4 || ' minutes')::interval)`,
      [id, U, opts.archived ?? false, String(opts.minutesAgo ?? 0)],
    );
  }

  /** Append a message. Returns its created_at as the pg driver parses it, which
   *  is exactly the value the route round-trips through `toISOString()`. */
  async function message(
    id: string,
    chatId: string,
    role: string,
    status: string | null,
    secondsAgo: number,
  ): Promise<Date> {
    const { pool } = await import("@/lib/db");
    const res = await pool.query<{ created_at: Date }>(
      `INSERT INTO messages (id, chat_id, role, content, metadata, created_at)
       VALUES ($1,$2,$3,'x',$4, now() - ($5 || ' seconds')::interval)
       RETURNING created_at`,
      [id, chatId, role, status ? JSON.stringify({ status }) : null, String(secondsAgo)],
    );
    return res.rows[0].created_at;
  }

  async function list(query = ""): Promise<Row[]> {
    const { GET } = await import("../route");
    const res = await GET(new Request(`http://x/api/chats${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Row[];
  }

  it("reports no attention for a chat with no messages", async () => {
    await chat("att-empty");
    const rows = await list();
    expect(rows.map((r) => r.id)).toEqual(["att-empty"]);
    expect(rows[0].attention).toBeNull();
  });

  it("derives approval / ask / failed from the last assistant message", async () => {
    await chat("att-approval", { minutesAgo: 1 });
    await chat("att-ask", { minutesAgo: 2 });
    await chat("att-failed", { minutesAgo: 3 });
    const approvalAt = await message("m-approval", "att-approval", "assistant", "awaiting_approval", 30);
    await message("m-ask", "att-ask", "assistant", "awaiting_answer", 30);
    await message("m-failed", "att-failed", "assistant", "failed", 30);

    const byId = new Map((await list()).map((r) => [r.id, r]));
    expect(byId.get("att-approval")!.attention).toEqual({
      kind: "approval",
      since: approvalAt.toISOString(),
    });
    expect(byId.get("att-ask")!.attention?.kind).toBe("ask");
    expect(byId.get("att-failed")!.attention?.kind).toBe("failed");
  });

  it("clears once the user has replied after the suspended turn", async () => {
    await chat("att-answered");
    await message("m-susp", "att-answered", "assistant", "awaiting_approval", 30);
    await message("m-reply", "att-answered", "user", null, 10);

    const rows = await list();
    expect(rows[0].attention).toBeNull();
  });

  it("ignores a completed turn and a non-assistant last message", async () => {
    await chat("att-done", { minutesAgo: 1 });
    await chat("att-user-last", { minutesAgo: 2 });
    await message("m-done", "att-done", "assistant", "completed", 30);
    await message("m-user", "att-user-last", "user", "awaiting_approval", 30);

    const byId = new Map((await list()).map((r) => [r.id, r]));
    expect(byId.get("att-done")!.attention).toBeNull();
    expect(byId.get("att-user-last")!.attention).toBeNull();
  });

  it("retires a failed reply once the chat has been opened after it, but keeps approval/ask", async () => {
    const { pool } = await import("@/lib/db");
    await chat("att-failed-seen", { minutesAgo: 1 });
    await chat("att-failed-unseen", { minutesAgo: 2 });
    await chat("att-approval-seen", { minutesAgo: 3 });
    await message("m-fs", "att-failed-seen", "assistant", "failed", 60);
    await message("m-fu", "att-failed-unseen", "assistant", "failed", 60);
    await message("m-as", "att-approval-seen", "assistant", "awaiting_approval", 60);
    // Opened 30s ago — after both 60s-old replies.
    await pool.query(`UPDATE chats SET last_read_at = now() - interval '30 seconds' WHERE id = ANY($1)`,
      [["att-failed-seen", "att-approval-seen"]]);

    const byId = new Map((await list()).map((r) => [r.id, r]));
    expect(byId.get("att-failed-seen")!.attention).toBeNull();
    expect(byId.get("att-failed-unseen")!.attention?.kind).toBe("failed");
    expect(byId.get("att-approval-seen")!.attention?.kind).toBe("approval");
    expect((await list("?attention=true")).map((r) => r.id).sort()).toEqual(["att-approval-seen", "att-failed-unseen"]);
  });

  it("attention=true returns only waiting chats, archived ones excluded", async () => {
    await chat("att-waiting", { minutesAgo: 1 });
    await chat("att-calm", { minutesAgo: 2 });
    await chat("att-archived", { archived: true, minutesAgo: 3 });
    await message("m-waiting", "att-waiting", "assistant", "awaiting_answer", 30);
    await message("m-calm", "att-calm", "assistant", "completed", 30);
    await message("m-arch", "att-archived", "assistant", "awaiting_answer", 30);

    const rows = await list("?attention=true");
    expect(rows.map((r) => r.id)).toEqual(["att-waiting"]);
    expect(rows[0].attention?.kind).toBe("ask");

    // The same filter with archived=true is the only way to see the archived one,
    // proving it was excluded by the archived default and not by the bucket.
    const archived = await list("?attention=true&archived=true");
    expect(archived.map((r) => r.id)).toEqual(["att-archived"]);
  });
});
