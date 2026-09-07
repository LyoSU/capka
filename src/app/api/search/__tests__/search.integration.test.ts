import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run search.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "search-test-user";
const OTHER = "search-test-other";

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});

type Body = {
  chats: { id: string; title: string | null }[];
  messages: { messageId: string; chatId: string; chatTitle: string | null; role: string; snippet: string }[];
};

run("GET /api/search", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    for (const id of [U, OTHER]) {
      await pool.query(
        `INSERT INTO "user" (id, name, email) VALUES ($1,'A',$1 || '@test.local') ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[U, OTHER]]);
  });

  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
  });

  async function chat(id: string, opts: { title?: string; archived?: boolean; userId?: string } = {}) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO chats (id, user_id, title, archived) VALUES ($1,$2,$3,$4)`,
      [id, opts.userId ?? U, opts.title ?? id, opts.archived ?? false],
    );
  }

  async function message(id: string, chatId: string, content: string, role = "user", secondsAgo = 0) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, created_at)
       VALUES ($1,$2,$3,$4, now() - ($5 || ' seconds')::interval)`,
      [id, chatId, role, content, String(secondsAgo)],
    );
  }

  async function search(query: string): Promise<Body> {
    const { GET } = await import("../route");
    const res = await GET(new Request(`http://x/api/search${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as Body;
  }

  it("answers nothing below the two-character floor", async () => {
    await chat("s-min", { title: "quarterly budget" });
    await message("m-min", "s-min", "the quarterly budget spreadsheet");

    expect(await search("?q=q")).toEqual({ chats: [], messages: [] });
    expect(await search("?q=%20%20")).toEqual({ chats: [], messages: [] });
    const hit = await search("?q=budget");
    expect(hit.chats.map((c) => c.id)).toEqual(["s-min"]);
    expect(hit.messages.map((m) => m.messageId)).toEqual(["m-min"]);
  });

  it("searches only the caller's own chats", async () => {
    await chat("s-mine", { title: "mine invoice" });
    await chat("s-theirs", { title: "theirs invoice", userId: OTHER });
    await message("m-mine", "s-mine", "an invoice for March");
    await message("m-theirs", "s-theirs", "an invoice for March");

    const body = await search("?q=invoice");
    expect(body.chats.map((c) => c.id)).toEqual(["s-mine"]);
    expect(body.messages.map((m) => m.messageId)).toEqual(["m-mine"]);
  });

  it("excludes archived chats unless archived=true", async () => {
    await chat("s-live", { title: "live receipt" });
    await chat("s-archived", { title: "archived receipt", archived: true });
    await message("m-live", "s-live", "the receipt is attached");
    await message("m-arch", "s-archived", "the receipt is attached");

    const plain = await search("?q=receipt");
    expect(plain.chats.map((c) => c.id)).toEqual(["s-live"]);
    expect(plain.messages.map((m) => m.messageId)).toEqual(["m-live"]);

    const withArchived = await search("?q=receipt&archived=true");
    expect(withArchived.chats.map((c) => c.id).sort()).toEqual(["s-archived", "s-live"]);
    expect(withArchived.messages.map((m) => m.messageId).sort()).toEqual(["m-arch", "m-live"]);
  });

  it("ranks a whole-word match above a substring-only one", async () => {
    await chat("s-lex");
    await chat("s-sub");
    // "budget" as its own word — the lexical lane matches it.
    await message("m-word", "s-lex", "please review the budget today");
    // Only ever as part of a longer word — no lexeme equals "budget", so only the
    // substring lane can find it. Newer, so a created_at tie-break would put it first.
    await message("m-partial", "s-sub", "see the budgeting notes", "user", 0);

    const body = await search("?q=budget");
    expect(body.messages.map((m) => m.messageId)).toEqual(["m-word", "m-partial"]);
  });

  it("marks the match in the snippet and keeps it to one line", async () => {
    await chat("s-snip");
    await message("m-snip", "s-snip", "line one\nthe budget is approved\nline three");
    await message("m-snip-partial", "s-snip", "our\nbudgeting rules", "user", 10);

    const byId = new Map((await search("?q=budget")).messages.map((m) => [m.messageId, m]));
    for (const id of ["m-snip", "m-snip-partial"]) {
      const snippet = byId.get(id)!.snippet;
      expect(snippet).toContain("<<");
      expect(snippet).toContain(">>");
      expect(snippet).not.toContain("\n");
    }
    expect(byId.get("m-snip")!.snippet).toContain("<<budget>>");
  });

  it("returns at most three hits from one chat", async () => {
    await chat("s-long");
    await chat("s-short");
    for (let i = 0; i < 6; i++) await message(`m-long-${i}`, "s-long", "the budget again", "user", i);
    await message("m-short", "s-short", "the budget once", "user", 10);

    const body = await search("?q=budget");
    const fromLong = body.messages.filter((m) => m.chatId === "s-long");
    expect(fromLong).toHaveLength(3);
    expect(body.messages.some((m) => m.chatId === "s-short")).toBe(true);
  });

  it("ignores non-conversation roles and treats wildcards literally", async () => {
    await chat("s-roles");
    await message("m-system", "s-roles", "budget in a system row", "system");
    await message("m-assistant", "s-roles", "budget in a reply", "assistant");
    await chat("s-wild", { title: "literal" });
    await message("m-wild", "s-wild", "a 50% discount");

    const roles = await search("?q=budget");
    expect(roles.messages.map((m) => m.messageId)).toEqual(["m-assistant"]);

    // `%d` as a pattern would match everything; escaped it matches only "50% d…".
    const wild = await search("?q=%25%20d");
    expect(wild.messages.map((m) => m.messageId)).toEqual(["m-wild"]);
  });
});
