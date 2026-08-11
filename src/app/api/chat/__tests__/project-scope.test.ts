import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A new chat inside a project is opened at a chat id the CLIENT already has:
 * /chat?projectId=p1 redirects to /chat/<nanoid>?projectId=p1 and no row is
 * written until the first send. So the very first POST carries BOTH a chatId
 * and a projectId while the chat row is still absent — the route must still
 * resolve the project and scope the turn to it.
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

// Rows the fake db hands back, per table, so a test can say "the chat row does
// not exist yet, but the project does".
const rows = vi.hoisted(() => ({
  chats: [] as Record<string, unknown>[],
  projects: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
}));
const writes = vi.hoisted(() => ({ inserted: [] as { table: string; values: unknown }[] }));

vi.mock("@/lib/db", async () => {
  // Routed by real drizzle table identity rather than call order, so the mock
  // doesn't quietly mis-answer if the route ever reorders its queries.
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
      insert: (table: never) => ({
        values: (values: unknown) => {
          writes.inserted.push({ table: getTableName(table), values });
          return Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() });
        },
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

import { POST } from "@/app/api/chat/route";

const send = (body: unknown) =>
  POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  rows.chats = [];
  rows.projects = [];
  rows.messages = [];
  writes.inserted = [];
  // A distinct user per test keeps the route's in-memory flood guard out of the way.
  requireRole.mockReset().mockResolvedValue({ userId: `u-${Math.random()}`, status: "active", role: "user" });
  resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: false, modelId: "m1", provider: "openai" });
  reserveBudget.mockReset().mockResolvedValue({ allowed: true });
  releaseHold.mockReset().mockResolvedValue(undefined);
  enqueueTask.mockReset().mockResolvedValue({ id: "t1", created: true });
});

describe("POST /api/chat — project scope on a pre-allocated chat id", () => {
  it("scopes the turn to the project when the chat row does not exist yet", async () => {
    rows.projects = [{ id: "p1" }];

    const res = await send({ chatId: "c-new", projectId: "p1", userMessage: "hi" });

    expect(res.status).toBe(200);
    // The project must reach both the new chat row and the queued turn — that is
    // what puts the turn in the project's workspace instead of a bare sandbox.
    expect(writes.inserted.find((w) => w.table === "chats")?.values).toMatchObject({ projectId: "p1" });
    expect(enqueueTask.mock.calls[0][0].payload).toMatchObject({ projectId: "p1" });
  });

  it("still 404s when the project id is not one of the user's projects", async () => {
    rows.projects = []; // ownership/soft-delete filters matched nothing

    const res = await send({ chatId: "c-new", projectId: "p-someone-elses", userMessage: "hi" });

    expect(res.status).toBe(404);
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
