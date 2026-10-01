import { describe, it, expect, vi, beforeEach } from "vitest";
import en from "../../../../messages/en.json";

// A link code minted before an account was suspended must not link it afterwards.
const { owner, writes } = vi.hoisted(() => ({ owner: { status: "active" }, writes: vi.fn() }));

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "for"]) chain[m] = () => chain;
  // The code lookup, the owner's status and findLink all read through this one chain;
  // a row carrying every field they ask for answers each of them.
  chain.limit = async () => [{ code: "ABC", userId: "u1", expiresAt: new Date(Date.now() + 60_000), status: owner.status }];
  const write = { values: writes, set: () => write, where: writes };
  const db = { select: () => chain, insert: () => write, update: () => write, delete: () => write, transaction: async (cb: (tx: unknown) => unknown) => cb(db) };
  return { db, pool: { connect: vi.fn() } };
});
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(async () => "123:TESTTOKEN"), setSetting: vi.fn(async () => {}) }));

const commands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
vi.mock("grammy", () => {
  class Bot {
    api = { deleteWebhook: vi.fn(async () => {}), setMyCommands: vi.fn(async () => {}) };
    on() { return this; }
    command(name: string, h: (ctx: unknown) => Promise<unknown>) { commands[name] = h; return this; }
    callbackQuery() { return this; }
    catch() { return this; }
    async start() {}
    async stop() {}
  }
  class InlineKeyboard {
    url() { return this; }
    text() { return this; }
    row() { return this; }
  }
  return { Bot, InlineKeyboard };
});

import { getBot } from "../bot";

const link = async () => {
  const ctx = { from: { id: 7, language_code: "en" }, chat: { id: 7 }, match: "abc", replyWithRichMessage: vi.fn(async () => ({})) };
  await commands.link(ctx);
  return ctx;
};

beforeEach(async () => {
  await getBot();
  writes.mockClear();
  owner.status = "active";
});

describe("telegram /link", () => {
  it("refuses to link an account that is suspended", async () => {
    owner.status = "suspended";
    const ctx = await link();
    expect(ctx.replyWithRichMessage).toHaveBeenCalledWith({ markdown: en.telegram.accountNotActive }, undefined);
    expect(writes).not.toHaveBeenCalled();
  });

  it("links an active account", async () => {
    const ctx = await link();
    expect(ctx.replyWithRichMessage).toHaveBeenCalledWith(expect.objectContaining({ markdown: en.telegram.linked }), expect.anything());
  });
});
