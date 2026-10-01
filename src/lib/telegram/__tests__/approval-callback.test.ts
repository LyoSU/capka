import { describe, it, expect, vi, beforeEach } from "vitest";
import en from "../../../../messages/en.json";

// A tapped approval button (`ma:`/`mr:`) must always answer its callback query —
// an unanswered one leaves Telegram's spinner on the button — and must say what
// really happened. Drives the real handler buildBot registers.
const { approveManageForUser, ask, account } = vi.hoisted(() => ({
  approveManageForUser: vi.fn(),
  ask: { onAskChoice: vi.fn(), onAskSkip: vi.fn(), onAskText: vi.fn() },
  account: { status: "active", role: "user" },
}));
vi.mock("@/lib/manage/authed", () => ({ approveManageForUser }));
vi.mock("../ask-collect", () => ask);

// findLink is the only query the handler makes: every select answers with the link,
// joined to its account's status and role.
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) chain[m] = () => chain;
  chain.limit = async () => [{ userId: "u1", telegramUserId: 7, ...account }];
  return { db: { select: () => chain }, pool: { connect: vi.fn() } };
});
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => "123:TESTTOKEN"),
  setSetting: vi.fn(async () => {}),
}));

// A stand-in for grammY that records the callback handlers by their pattern, and the
// plain-text handler.
const callbacks: [RegExp | string, (ctx: unknown) => Promise<unknown>][] = [];
const on: Record<string, (ctx: unknown) => Promise<unknown>> = {};
vi.mock("grammy", () => {
  class Bot {
    api = { deleteWebhook: vi.fn(async () => {}), setMyCommands: vi.fn(async () => {}) };
    on(filter: unknown, h: (ctx: unknown) => Promise<unknown>) { if (typeof filter === "string") on[filter] = h; return this; }
    command() { return this; }
    callbackQuery(pattern: RegExp | string, h: (ctx: unknown) => Promise<unknown>) { callbacks.push([pattern, h]); return this; }
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

import { AppError, BudgetExceededError } from "@/lib/errors";
import { getBot } from "../bot";

const tap = async (data: string) => {
  const entry = callbacks.find(([p]) => (typeof p === "string" ? p === data : p.test(data)));
  expect(entry, data).toBeDefined();
  const ctx = {
    from: { id: 7, language_code: "en" },
    chat: { id: 7 },
    match: data.match(entry![0]),
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageReplyMarkup: vi.fn(async () => {}),
  };
  await entry![1](ctx);
  return ctx;
};

beforeEach(async () => {
  await getBot();
  approveManageForUser.mockReset();
  Object.values(ask).forEach((f) => f.mockReset());
  Object.assign(account, { status: "active", role: "user" });
});

describe("telegram approval callback", () => {
  it("answers the flood guard's refusal and keeps the buttons, instead of leaving the spinner", async () => {
    approveManageForUser.mockRejectedValue(new AppError("Too many messages — please slow down.", 429, "RATE_LIMITED"));
    const ctx = await tap("ma:m1:#abc");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: en.telegram.tooFast });
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("answers the spending limit the same way", async () => {
    approveManageForUser.mockRejectedValue(new BudgetExceededError("d1"));
    const ctx = await tap("mr:m1:#abc");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: en.telegram.budgetReached });
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("does not say Done when the decision was kept but its turn could not continue", async () => {
    approveManageForUser.mockResolvedValue("failed");
    const ctx = await tap("ma:m1:#abc");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: en.telegram.confirmStopped });
    // Recorded: tapping again could do nothing, so the buttons come off.
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("says Done for a decision that went through", async () => {
    approveManageForUser.mockResolvedValue("applied");
    const ctx = await tap("ma:m1:#abc");
    expect(approveManageForUser).toHaveBeenCalledWith("u1", { messageId: "m1", toolCallId: "#abc", approved: true });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: en.telegram.confirmApplied });
  });

  it("still lets an unexpected error through to the bot's error handler", async () => {
    approveManageForUser.mockRejectedValue(new Error("db down"));
    await expect(tap("ma:m1:#abc")).rejects.toThrow("db down");
  });

  // The web refuses both on /api/manage/approve and /api/ask/answer; a button tap
  // resumes the same paid turn, so it must refuse them too.
  it.each([
    [{ status: "suspended", role: "user" }, en.telegram.accountNotActive],
    [{ status: "active", role: "viewer" }, en.telegram.readOnly],
  ])("refuses an account that may not spend (%o) and keeps the buttons", async (who, text) => {
    Object.assign(account, who);
    const ctx = await tap("ma:m1:#abc");
    expect(approveManageForUser).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text });
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("does not let a suspended account answer a question by button or by text", async () => {
    account.status = "suspended";
    const choice = await tap("ta:0:0");
    expect(choice.answerCallbackQuery).toHaveBeenCalledWith({ text: en.telegram.accountNotActive });
    await tap("taskip");
    expect(ask.onAskChoice).not.toHaveBeenCalled();
    expect(ask.onAskSkip).not.toHaveBeenCalled();

    // Falls through to the burst buffer instead, where ingest answers the refusal.
    await on["message:text"]({
      from: { id: 7, language_code: "en" },
      chat: { id: 7 },
      message: { text: "yes" },
      replyWithChatAction: vi.fn(async () => {}),
    });
    expect(ask.onAskText).not.toHaveBeenCalled();
  });
});
