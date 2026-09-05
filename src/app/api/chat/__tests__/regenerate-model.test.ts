import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A regenerate re-runs the same prompt, so it posts an EMPTY userMessage — that
 * is what tells the route not to insert a second user row. The turn's settings
 * (model, thinking depth) used to be written inside that same `if (text)` block,
 * so re-running after switching models ran on the new model but left the chat row
 * on the old one. Three surfaces read that row and all three lied: the picker on
 * reload, the "last used model" a new chat opens with, and the sidebar order.
 */
const { requireRole, resolveUserModelInfo, reserveBudget, releaseHold, enqueueTask } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveUserModelInfo: vi.fn(),
  reserveBudget: vi.fn(),
  releaseHold: vi.fn(),
  enqueueTask: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireRole };
});
vi.mock("@/lib/providers/resolve", () => ({ resolveUserModelInfo }));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget, releaseHold }));
vi.mock("@/lib/tasks/queue", () => ({ enqueueTask }));

const rows = vi.hoisted(() => ({
  chats: [] as Record<string, unknown>[],
  projects: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
}));
// Unlike the project-scope suite this one asserts on UPDATEs, so the fake db
// records what each `.set()` was handed, tagged by table.
const writes = vi.hoisted(() => ({ updated: [] as { table: string; values: Record<string, unknown> }[] }));

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const select = () => ({
    from: (table: never) => {
      const name = getTableName(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["leftJoin", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
      chain.limit = () => Promise.resolve(rows[name as keyof typeof rows] ?? []);
      return chain;
    },
  });
  return {
    db: {
      select,
      insert: () => ({
        values: () => Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() }),
      }),
      update: (table: never) => ({
        set: (values: Record<string, unknown>) => {
          writes.updated.push({ table: getTableName(table), values });
          return { where: () => Promise.resolve() };
        },
      }),
    },
  };
});

import { POST } from "@/app/api/chat/route";

const send = (body: unknown) =>
  POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));

const chatUpdate = () => writes.updated.find((w) => w.table === "chats")?.values;

beforeEach(() => {
  rows.chats = [];
  rows.projects = [];
  rows.messages = [];
  writes.updated = [];
  requireRole.mockReset().mockResolvedValue({ userId: `u-${Math.random()}`, status: "active", role: "user" });
  resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: false, modelId: "m1", provider: "openai" });
  reserveBudget.mockReset().mockResolvedValue({ allowed: true });
  releaseHold.mockReset().mockResolvedValue(undefined);
  enqueueTask.mockReset().mockResolvedValue({ id: "t1", created: true });
});

describe("POST /api/chat — a regenerate persists the turn's settings", () => {
  it("writes the newly picked model onto the chat even with no user message", async () => {
    const userId = "u-regen";
    requireRole.mockResolvedValue({ userId, status: "active", role: "user" });
    rows.chats = [{ id: "c1", userId, title: "Hi", model: "cfg1:old-model", activeLeafId: "m9" }];

    const res = await send({ chatId: "c1", userMessage: "", model: "cfg1:new-model" });

    expect(res.status).toBe(200);
    // The turn runs on the new model...
    expect(enqueueTask.mock.calls[0][0].payload).toMatchObject({ requestModel: "cfg1:new-model" });
    // ...and the chat row now agrees with it, so the picker and the "last used
    // model" of the next new chat both report what actually ran.
    expect(chatUpdate()).toMatchObject({ model: "cfg1:new-model" });
  });

  it("bumps updatedAt on a regenerate that changed nothing", async () => {
    const userId = "u-regen-same";
    requireRole.mockResolvedValue({ userId, status: "active", role: "user" });
    rows.chats = [{ id: "c1", userId, title: "Hi", model: "cfg1:m", activeLeafId: "m9" }];

    await send({ chatId: "c1", userMessage: "", model: "cfg1:m" });

    // No setting changed, but work happened: the sidebar orders on this column and
    // so does resolveInitialModel's "most recent chat that has a model".
    expect(chatUpdate()?.updatedAt).toBeInstanceOf(Date);
    expect(chatUpdate()).not.toHaveProperty("activeLeafId");
  });

  it("persists a thinking-depth switch made just before regenerating", async () => {
    const userId = "u-regen-think";
    requireRole.mockResolvedValue({ userId, status: "active", role: "user" });
    rows.chats = [{ id: "c1", userId, title: "Hi", model: "cfg1:m", thinkAmount: "brief", activeLeafId: "m9" }];

    await send({ chatId: "c1", userMessage: "", model: "cfg1:m", thinkAmount: "deep" });

    // The worker reads think depth off the chat row, not the payload — unpersisted,
    // the re-run would silently think at the old depth.
    expect(chatUpdate()).toMatchObject({ thinkAmount: "deep" });
  });

  it("does not touch a chat row that does not exist yet", async () => {
    const userId = "u-regen-nochat";
    requireRole.mockResolvedValue({ userId, status: "active", role: "user" });
    rows.chats = [];

    await send({ chatId: "c-new", userMessage: "", model: "cfg1:m" });

    // Nothing to re-run and no row to update: the insert above already carried the
    // model, so an UPDATE here would just be a write against a fresh row.
    expect(chatUpdate()).toBeUndefined();
  });
});
