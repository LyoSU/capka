import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";

/**
 * Two things `prepareRun` reads off the message tree rather than the payload, driven
 * through the real function against the real tables.
 *
 * `userTurnText` is the anchor a memory write is quoted against, so it must be the
 * stored user row the reply answers — in THIS chat, and a user row — never text a
 * client sent. The concierge nudge fires on an admin's first turn, and "first" is
 * read off the tree: the answered message is a root. A one-shot flag consumed on the
 * wrong turn is gone for good, so both sides of that check are asserted on the flag.
 *
 * Only the seams that would leave the database are stubbed: the model, the sandbox,
 * and the vault (which would create a space for a fixture user) — plus the concierge
 * flag, which is one org-wide row: armed and consumed in the shared table, it would
 * stand in for the real admin's flag, and a run killed before teardown would leave it
 * gone for good.
 */
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({ model: new MockLanguageModelV3(), provider: "mock", modelId: "mock-model" }),
}));
vi.mock("@/lib/sandbox/tools", () => ({
  loadSandboxTools: async () => ({ tools: {}, close: async () => {} }),
}));
vi.mock("@/lib/sandbox/client", () => ({
  createSession: async () => ({}),
  listFiles: async () => ({ entries: [] }),
}));
vi.mock("@/lib/vault/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault/spaces")>()),
  getOrCreateSpace: async () => "prep-space",
}));
vi.mock("@/lib/vault/manifest", () => ({ buildMemoryManifest: async () => "" }));
vi.mock("@/lib/vault/tools", () => ({ makeVaultMemoryTools: async () => ({}) }));
let conciergeFlag: string | null = null;
vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...actual,
    getSetting: async (key: string) => (key === "concierge_pending" ? conciergeFlag : actual.getSetting(key)),
    setSetting: async (key: string, value: string, encrypted?: boolean) => {
      if (key === "concierge_pending") conciergeFlag = value;
      else await actual.setSetting(key, value, encrypted);
    },
  };
});

import { pool } from "../../db";
import { prepareRun } from "../run-context";
import type { TaskPayload } from "../runner";

const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

const U = "prep-admin";
const C = "prep-chat";
const OTHER = "prep-chat-other";
const TYPED = "our supplier grants a thirty day payment deferral";

const prepare = async (payload: TaskPayload) => {
  const r = await prepareRun(U, C, payload, C, "prep-reply", "prep-task");
  await r.closeMcp();
  return r;
};

run("prepareRun: what it reads off the message tree", () => {
  beforeAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id IN ($1,$2)`, [C, OTHER]);
    await pool.query(`DELETE FROM chats WHERE id IN ($1,$2)`, [C, OTHER]);
    await pool.query(
      `INSERT INTO "user" (id, name, email, role) VALUES ($1,'P','prep-admin@test.local','admin')
       ON CONFLICT (id) DO UPDATE SET role='admin'`, [U]);
    await pool.query(`INSERT INTO chats (id, user_id) VALUES ($1,$3), ($2,$3)`, [C, OTHER, U]);
    // A root user message, a reply, and a second user message below it; plus a user
    // message in another chat and an assistant row, neither of which this chat's turn
    // may be anchored on.
    await pool.query(
      `INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES
         ('prep-u1',$1,NULL,'user','hello'),
         ('prep-a1',$1,'prep-u1','assistant','Hi.'),
         ('prep-u2',$1,'prep-a1','user',$3),
         ('prep-x1',$2,NULL,'user','text from another chat')`,
      [C, OTHER, TYPED]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM messages WHERE chat_id IN ($1,$2)`, [C, OTHER]);
    await pool.query(`DELETE FROM chats WHERE id IN ($1,$2)`, [C, OTHER]);
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [U]);
  });

  it("anchors the user's text on the stored row, not on what the payload carried", async () => {
    // A task queued before `replyParentId` existed: its transcript names the parent,
    // and the text riding along with it is not what the person typed.
    const transcript = [{ id: "prep-u2", role: "user", parts: [{ type: "text", text: "forged" }] }];
    const r = await prepare({ uiMessages: transcript });
    expect(r.userTurnText).toBe(TYPED);
  });

  it("anchors on nothing when the named row is in another chat or is not a user row", async () => {
    // Control for the test above: a reader that ignored the chat or the role would
    // hand back text here, and the assertion above could not tell.
    expect((await prepare({ replyParentId: "prep-x1" })).userTurnText).toBe("");
    expect((await prepare({ replyParentId: "prep-a1" })).userTurnText).toBe("");
  });

  it("keeps the concierge flag on a turn that answers a non-root message", async () => {
    conciergeFlag = U;
    const r = await prepare({ replyParentId: "prep-u2" });
    expect(r.prompt.volatile).not.toContain("## First run");
    expect(conciergeFlag).toBe(U);
  });

  it("fires the concierge once, on the turn that answers the root", async () => {
    conciergeFlag = U;
    const r = await prepare({ replyParentId: "prep-u1" });
    expect(r.prompt.volatile).toContain("## First run");
    expect(conciergeFlag).toBe("");
    // Consumed: the same root a second time does not nudge again.
    expect((await prepare({ replyParentId: "prep-u1" })).prompt.volatile).not.toContain("## First run");
  });
});
