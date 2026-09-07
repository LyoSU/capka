import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run title-regenerate.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "title-regen-test-user";
const OTHER = "title-regen-other-user";

const { requireSession, generateChatTitle, resolveAuxTarget, resolveUserModelInfo, publishTaskEvent, recordUsage } =
  vi.hoisted(() => ({
    requireSession: vi.fn(),
    generateChatTitle: vi.fn(),
    resolveAuxTarget: vi.fn(),
    resolveUserModelInfo: vi.fn(),
    publishTaskEvent: vi.fn(),
    recordUsage: vi.fn(),
  }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  // The routes gate mutations with `requireWriter`, which calls the module-internal
  // `requireSession` — not this mock — and reaches for `headers()` outside a request.
  // Answer both with the same session so the role a test sets is the one the route sees.
  return { ...actual, requireSession, requireWriter: requireSession };
});
// No provider is reachable from a test run, and resolving one would demand a
// configured connection this suite has no business creating.
vi.mock("@/lib/providers/resolve", () => ({ resolveAuxTarget, resolveUserModelInfo }));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent }));
vi.mock("@/lib/usage", () => ({ recordUsage }));

// The config id has to be a real row: the route now reserves budget before calling
// the model, and a hold references `provider_configs` by foreign key.
const CFG = "title-regen-cfg";
const TARGET = { model: {}, provider: "openai", modelId: "gpt-x", configId: CFG, isShared: true };

/**
 * POST /api/chats/[id]/title re-derives a chat's name on demand.
 *
 * The cases worth a database are the ones about WHICH row gets written and when
 * it does not: an abstaining model and a chat with nothing answered yet must both
 * leave the stored title exactly as it was, and a chat belonging to someone else
 * must not be readable at all.
 */
run("POST /api/chats/[id]/title", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    for (const [id, email] of [[U, "title-regen@test.local"], [OTHER, "title-regen-other@test.local"]]) {
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'T',$2) ON CONFLICT (id) DO NOTHING`, [id, email]);
    }
    await pool.query(
      `INSERT INTO provider_configs (id, user_id, provider) VALUES ($1,$2,'openai') ON CONFLICT (id) DO NOTHING`,
      [CFG, U],
    );
  });

  afterAll(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    await pool.query(`DELETE FROM provider_configs WHERE id = $1`, [CFG]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [[U, OTHER]]);
  });

  beforeEach(async () => {
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE user_id = ANY($1)`, [[U, OTHER]]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
    resolveUserModelInfo.mockReset().mockResolvedValue(TARGET);
    resolveAuxTarget.mockReset().mockResolvedValue(TARGET);
    generateChatTitle.mockReset();
    publishTaskEvent.mockReset().mockResolvedValue(undefined);
    recordUsage.mockReset().mockResolvedValue(undefined);
  });

  async function chat(id: string, title: string, owner = U) {
    const { pool } = await import("@/lib/db");
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ($1,$2,$3)`, [id, owner, title]);
  }

  /** Append one message to the chain and pin it as the active leaf. */
  async function say(id: string, chatId: string, role: string, content: string, parentId: string | null) {
    const { pool } = await import("@/lib/db");
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [id, chatId, parentId, role, content],
    );
    await pool.query(`UPDATE chats SET active_leaf_id = $1 WHERE id = $2`, [id, chatId]);
    return id;
  }

  async function post(chatId: string) {
    const { POST } = await import("../[id]/title/route");
    return POST(new Request(`http://x/api/chats/${chatId}/title`, { method: "POST" }), {
      params: Promise.resolve({ id: chatId }),
    });
  }

  async function titleOf(chatId: string): Promise<string | null> {
    const { pool } = await import("@/lib/db");
    const r = await pool.query(`SELECT title FROM chats WHERE id = $1`, [chatId]);
    return (r.rows[0]?.title as string | null) ?? null;
  }

  it("409s a chat that has no reply yet, and calls no model", async () => {
    await chat("tr-empty", "Placeholder");
    await say("tr-m1", "tr-empty", "user", "Draft the quarterly summary", null);

    const res = await post("tr-empty");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nothing_to_title" });
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(await titleOf("tr-empty")).toBe("Placeholder");
  });

  it("writes the new title, announces it, and returns it", async () => {
    await chat("tr-ok", "Placeholder");
    const u = await say("tr-m2", "tr-ok", "user", "Draft the quarterly summary", null);
    await say("tr-m3", "tr-ok", "assistant", "Here is the draft.", u);
    generateChatTitle.mockResolvedValue("Quarterly summary draft");

    const res = await post("tr-ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Quarterly summary draft" });
    expect(await titleOf("tr-ok")).toBe("Quarterly summary draft");
    expect(publishTaskEvent).toHaveBeenCalledWith(U, {
      type: "chat:title", chatId: "tr-ok", title: "Quarterly summary draft",
    });
  });

  it("leaves the row alone when the model abstains", async () => {
    await chat("tr-null", "Placeholder");
    const u = await say("tr-m4", "tr-null", "user", "hi", null);
    await say("tr-m5", "tr-null", "assistant", "Hello.", u);
    generateChatTitle.mockResolvedValue(null);

    const res = await post("tr-null");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: null });
    expect(await titleOf("tr-null")).toBe("Placeholder");
    expect(publishTaskEvent).not.toHaveBeenCalled();
  });

  it("404s another user's chat without reading it", async () => {
    await chat("tr-foreign", "Not yours", OTHER);
    const u = await say("tr-m6", "tr-foreign", "user", "Secret plan", null);
    await say("tr-m7", "tr-foreign", "assistant", "Understood.", u);
    generateChatTitle.mockResolvedValue("Should never happen");

    const res = await post("tr-foreign");
    expect(res.status).toBe(404);
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(await titleOf("tr-foreign")).toBe("Not yours");
  });

  it("titles from the ACTIVE branch, not an abandoned one", async () => {
    // Two replies share a parent; the leaf pins the second. A title derived from
    // the abandoned sibling would name the chat after text nobody can see.
    await chat("tr-branch", "Placeholder");
    const u = await say("tr-m8", "tr-branch", "user", "Compare the two vendors", null);
    await say("tr-m9", "tr-branch", "assistant", "ABANDONED BRANCH", u);
    await say("tr-m10", "tr-branch", "assistant", "CHOSEN BRANCH", u);
    generateChatTitle.mockResolvedValue("Vendor comparison");

    expect((await post("tr-branch")).status).toBe(200);
    expect(generateChatTitle).toHaveBeenCalledWith(
      TARGET.model, TARGET.provider, "Compare the two vendors", "CHOSEN BRANCH", expect.any(Function),
    );
  });
});
