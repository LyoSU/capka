import { describe, it, expect, vi, beforeEach } from "vitest";
import en from "../../../../messages/en.json";

// A tapped approval button (`ma:`/`mr:`) must always answer its callback query —
// an unanswered one leaves Telegram's spinner on the button — and must say what
// really happened. Drives the real handler buildBot registers.
const { approveManageForUser } = vi.hoisted(() => ({ approveManageForUser: vi.fn() }));
vi.mock("@/lib/manage/authed", () => ({ approveManageForUser }));

// findLink is the only query the handler makes: every select answers with the link.
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) chain[m] = () => chain;
  chain.limit = async () => [{ userId: "u1", telegramUserId: 7 }];
  return { db: { select: () => chain }, pool: { connect: vi.fn() } };
});
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => "123:TESTTOKEN"),
  setSetting: vi.fn(async () => {}),
}));

// A stand-in for grammY that records the callback handlers by their pattern.
const callbacks: [RegExp, (ctx: unknown) => Promise<unknown>][] = [];
vi.mock("grammy", () => {
  class Bot {
    api = { deleteWebhook: vi.fn(async () => {}), setMyCommands: vi.fn(async () => {}) };
    on() { return this; }
    command() { return this; }
    callbackQuery(pattern: RegExp, h: (ctx: unknown) => Promise<unknown>) { callbacks.push([pattern, h]); return this; }
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
  const entry = callbacks.find(([p]) => p.test(data));
  expect(entry, data).toBeDefined();
  const ctx = {
    from: { id: 7, language_code: "en" },
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
});
