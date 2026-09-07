import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run secrets.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "chat-secrets-test-user";
const OTHER = "chat-secrets-other-user";

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  // The routes gate mutations with `requireWriter`, which calls the module-internal
  // `requireSession` — not this mock — and reaches for `headers()` outside a request.
  // Answer both with the same session so the role a test sets is the one the route sees.
  return { ...actual, requireSession, requireWriter: requireSession };
});

/**
 * The write-only contract of chat secrets, end to end through the route.
 *
 * Two things are asserted that a unit test cannot: that the value is genuinely
 * absent from every response the browser can reach, and that a chat belonging to
 * somebody else answers 404 rather than 403 — a distinguishable "forbidden" would
 * turn this route into an oracle for other people's chat ids.
 */
run("/api/chats/[id]/secrets", () => {
  beforeAll(async () => {
    const { pool } = await import("@/lib/db");
    for (const [id, email] of [[U, "chat-secrets@test.local"], [OTHER, "chat-secrets-other@test.local"]]) {
      await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1,'S',$2) ON CONFLICT (id) DO NOTHING`, [id, email]);
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
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ('cs-mine',$1,'mine')`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id, title) VALUES ('cs-theirs',$1,'theirs')`, [OTHER]);
    requireSession.mockReset().mockResolvedValue({ userId: U, role: "user", status: "active" });
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function get(id: string) {
    const { GET } = await import("../[id]/secrets/route");
    return GET(new Request(`http://x/api/chats/${id}/secrets`), params(id));
  }
  async function post(id: string, body: unknown) {
    const { POST } = await import("../[id]/secrets/route");
    return POST(new Request(`http://x/api/chats/${id}/secrets`, { method: "POST", body: JSON.stringify(body) }), params(id));
  }
  async function del(id: string, body: unknown) {
    const { DELETE } = await import("../[id]/secrets/route");
    return DELETE(new Request(`http://x/api/chats/${id}/secrets`, { method: "DELETE", body: JSON.stringify(body) }), params(id));
  }

  it("stores a credential, lists its name, and never returns the value", async () => {
    const saved = await post("cs-mine", { name: "stripe key", value: "sk-live-secret-value" });
    expect(saved.status).toBe(200);
    // Normalised on the way in, so the user types words and gets a variable name.
    expect(await saved.json()).toEqual({ name: "STRIPE_KEY" });

    const listed = await get("cs-mine");
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(JSON.parse(body).secrets.map((s: { name: string }) => s.name)).toEqual(["STRIPE_KEY"]);
    // The whole point of the feature, asserted on the raw bytes rather than on a
    // field name — a value could only reach the browser through some key nobody
    // thought to check.
    expect(body).not.toContain("sk-live-secret-value");

    // ...and the row itself holds ciphertext, not the credential.
    const { pool } = await import("@/lib/db");
    const rows = await pool.query(`SELECT value_enc FROM chat_secrets WHERE chat_id = 'cs-mine'`);
    expect(rows.rows[0].value_enc).not.toContain("sk-live-secret-value");

    const removed = await del("cs-mine", { name: "STRIPE_KEY" });
    expect(removed.status).toBe(200);
    expect((await (await get("cs-mine")).json()).secrets).toEqual([]);
  });

  it("re-saving a name replaces the credential instead of stacking a second one", async () => {
    await post("cs-mine", { name: "TOKEN", value: "first" });
    await post("cs-mine", { name: "TOKEN", value: "second" });
    expect((await (await get("cs-mine")).json()).secrets).toHaveLength(1);

    // The injection reads one value for one name, so "replaced" has to be true of
    // the decrypted environment, not merely of the row count.
    const { loadSecretEnv } = await import("@/lib/chat/secrets");
    expect(await loadSecretEnv("cs-mine")).toEqual({ TOKEN: "second" });
  });

  it("refuses a name that cannot be a variable, and an empty value", async () => {
    expect((await post("cs-mine", { name: "1password", value: "x" })).status).toBe(400);
    expect((await post("cs-mine", { name: "TOKEN", value: "" })).status).toBe(400);
    expect((await (await get("cs-mine")).json()).secrets).toEqual([]);
  });

  it("answers 404 for someone else's chat, on every verb", async () => {
    expect((await get("cs-theirs")).status).toBe(404);
    expect((await post("cs-theirs", { name: "TOKEN", value: "x" })).status).toBe(404);
    expect((await del("cs-theirs", { name: "TOKEN" })).status).toBe(404);
    // A missing chat is indistinguishable from a foreign one — same status, so the
    // route cannot be used to discover which ids exist.
    expect((await get("cs-nonexistent")).status).toBe(404);
  });

  it("deleting the chat takes its credentials with it", async () => {
    await post("cs-mine", { name: "TOKEN", value: "value-here" });
    const { pool } = await import("@/lib/db");
    await pool.query(`DELETE FROM chats WHERE id = 'cs-mine'`);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM chat_secrets WHERE chat_id = 'cs-mine'`);
    expect(rows.rows[0].n).toBe(0);
  });
});
