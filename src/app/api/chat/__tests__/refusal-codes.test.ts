import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import en from "../../../../../messages/en.json";
import uk from "../../../../../messages/uk.json";

/**
 * Every refusal the composer can meet carries a machine code, and the client turns
 * that code into a line in the user's language. Several refusals used to arrive as
 * the route's bare English ("Conversation is out of date — please reload."), shown
 * verbatim to a Ukrainian-speaking user, because the client had no code to map.
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
  return { db: { select } };
});

import { POST } from "@/app/api/chat/route";
import { REFUSALS, refusal } from "@/hooks/use-background-chat";
import { createTranslator } from "next-intl";

const send = (body: unknown) =>
  POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));

let userId = "";
beforeEach(() => {
  rows.chats = [];
  rows.projects = [];
  rows.messages = [];
  // A distinct user per test keeps the route's in-memory flood guard out of the way.
  userId = `u-${Math.random()}`;
  requireRole.mockReset().mockResolvedValue({ userId, status: "active", role: "user" });
  resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: false, modelId: "m1", provider: "openai" });
  reserveBudget.mockReset().mockResolvedValue({ allowed: true });
  releaseHold.mockReset().mockResolvedValue(undefined);
  enqueueTask.mockReset().mockResolvedValue({ id: "t1", created: true });
});

const refused = async (res: Response) => ({ status: res.status, code: ((await res.json()) as { code?: string }).code });

describe("POST /api/chat — refusals carry a code the composer can translate", () => {
  it("someone else's chat", async () => {
    rows.chats = [{ id: "c1", userId: "someone-else" }];
    expect(await refused(await send({ chatId: "c1", userMessage: "hi" }))).toEqual({ status: 404, code: "CHAT_NOT_FOUND" });
  });

  it("a chat retargeted to another project", async () => {
    rows.chats = [{ id: "c1", userId, projectId: "p1" }];
    expect(await refused(await send({ chatId: "c1", projectId: "p2", userMessage: "hi" }))).toEqual({ status: 409, code: "CHAT_PROJECT_MISMATCH" });
  });

  it("a chat whose project is being deleted", async () => {
    rows.chats = [{ id: "c1", userId, projectId: "p1", projectDeletedAt: new Date() }];
    expect(await refused(await send({ chatId: "c1", userMessage: "hi" }))).toEqual({ status: 409, code: "PROJECT_DELETING" });
  });

  it("a new chat in a project that is not the user's", async () => {
    expect(await refused(await send({ chatId: "c-new", projectId: "p-x", userMessage: "hi" }))).toEqual({ status: 404, code: "PROJECT_NOT_FOUND" });
  });

  it("a Telegram chat written to from the web", async () => {
    rows.chats = [{ id: "c1", userId, source: "telegram" }];
    expect(await refused(await send({ chatId: "c1", userMessage: "hi" }))).toEqual({ status: 403, code: "TELEGRAM_CHAT" });
  });

  it("a send anchored to a message this chat no longer has", async () => {
    rows.chats = [{ id: "c1", userId, activeLeafId: "m9" }];
    expect(await refused(await send({ chatId: "c1", userMessage: "hi", parentId: "gone" }))).toEqual({ status: 409, code: "STALE_CONVERSATION" });
  });

  it("a model the resolver refuses — thrown, not written as a literal", async () => {
    const { ValidationError } = await import("@/lib/errors");
    resolveUserModelInfo.mockRejectedValue(new ValidationError("No default model set. Configure one in Settings → Connections."));
    expect(await refused(await send({ chatId: "c-new", userMessage: "hi" }))).toEqual({ status: 400, code: "MODEL_UNAVAILABLE" });
    // Anything else it throws is not a refusal the user can act on — it stays a server error.
    resolveUserModelInfo.mockRejectedValue(new Error("connection reset"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send({ chatId: "c-new", userMessage: "hi" })).status).toBe(500);
    quiet.mockRestore();
  });

  it("an expired session and an account that may not send", async () => {
    const { UnauthorizedError, ForbiddenError } = await import("@/lib/errors");
    requireRole.mockRejectedValue(new UnauthorizedError());
    expect(await refused(await send({ chatId: "c-new", userMessage: "hi" }))).toEqual({ status: 401, code: "UNAUTHORIZED" });
    requireRole.mockRejectedValue(new ForbiddenError("Your access has been suspended. Contact your administrator."));
    expect(await refused(await send({ chatId: "c-new", userMessage: "hi" }))).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  it("every code the route sends reads as a line in both languages", () => {
    const src = readFileSync("src/app/api/chat/route.ts", "utf8");
    // Thrown, not written as literals: BUDGET_EXCEEDED (BudgetExceededError), and
    // requireRole's UNAUTHORIZED / FORBIDDEN.
    const codes = [...new Set([...src.matchAll(/code: "([A-Z_]+)"/g)].map((m) => m[1])), "BUDGET_EXCEEDED", "UNAUTHORIZED", "FORBIDDEN"];
    expect(codes).toContain("STALE_CONVERSATION"); // the scan itself found the literals
    for (const code of codes) {
      const key = REFUSALS[code];
      expect(key, code).toBeTruthy();
      expect((en.chat.hook as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((uk.chat.hook as Record<string, string>)[key], `uk ${key}`).toBeTruthy();
    }
  });
});

describe("refusal — what the composer shows for a refused send", () => {
  const t = createTranslator({ locale: "uk", messages: uk, namespace: "chat.hook" }) as unknown as Parameters<typeof refusal>[1];
  const shown = async (status: number, body?: unknown) =>
    (await refusal(new Response(body === undefined ? null : JSON.stringify(body), { status }), t)).message;

  it("a coded refusal reads in the user's language", async () => {
    expect(await shown(401, { error: "Unauthorized", code: "UNAUTHORIZED" })).toBe(uk.chat.hook.sessionEnded);
    expect(await shown(403, { error: "Your account is awaiting administrator approval.", code: "FORBIDDEN" })).toBe(uk.chat.hook.accountCantSend);
  });

  it("the proxy's uncoded 401 still reads as an ended session", async () => {
    expect(await shown(401, { error: "Unauthorized" })).toBe(uk.chat.hook.sessionEnded);
  });
});
