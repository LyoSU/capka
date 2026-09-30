import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot } from "grammy";
import type { AskForm } from "@/lib/ask/types";

// getTranslator is imported statically — stub it to echo the key so assertions read
// the message id ("expired" / "answered") directly.
vi.mock("@/lib/i18n/translator", () => ({ getTranslator: () => (k: string) => k }));

// The answer helpers are imported dynamically inside finish(); mock both.
const answerAskForUser = vi.fn();
const answerElicitationForUser = vi.fn();
vi.mock("@/lib/ask/authed", () => ({
  answerAskForUser: (...a: unknown[]) => answerAskForUser(...a),
  answerElicitationForUser: (...a: unknown[]) => answerElicitationForUser(...a),
}));

import { AppError, BudgetExceededError } from "@/lib/errors";
import { startAskCollection, onAskText } from "../ask-collect";

const sent: string[] = [];
const bot = { api: { sendMessage: vi.fn(async (_c: number, text: string) => { sent.push(text); }) } } as unknown as Bot;
const CHAT = 555;
const oneTextField: AskForm = { fields: [{ id: "q", label: "Your name?", kind: "text" }] };

beforeEach(() => {
  sent.length = 0;
  answerAskForUser.mockReset().mockResolvedValue(true);
  answerElicitationForUser.mockReset().mockResolvedValue(true);
  (bot.api.sendMessage as ReturnType<typeof vi.fn>).mockClear();
});

describe("telegram ask-collect — expiry", () => {
  it("swallows an in-time free-text reply and records the answer", async () => {
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "ask" });
    const handled = await onAskText(bot, CHAT, "u1", "Alice");
    expect(handled).toBe(true); // captured — not treated as a new chat turn
    expect(answerAskForUser).toHaveBeenCalledOnce();
  });

  it("does NOT swallow a late reply once the collection has expired (it becomes a normal turn)", async () => {
    // ttlMs:0 → expires immediately, mirroring a timed-out MCP elicitation.
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "elicitation", ttlMs: 0 });
    const handled = await onAskText(bot, CHAT, "u1", "Alice (too late)");
    expect(handled).toBe(false); // caller routes it as a fresh Telegram message
    expect(answerElicitationForUser).not.toHaveBeenCalled();
  });

  it("reports 'expired' (not 'answered') when the suspended question is already resolved/gone", async () => {
    answerElicitationForUser.mockResolvedValue(false); // row already deleted after timeout
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "elicitation" });
    await onAskText(bot, CHAT, "u1", "Alice");
    expect(sent).toContain("expired");
    expect(sent).not.toContain("answered");
  });
});

describe("telegram ask-collect — spending limit", () => {
  it("says the limit was reached and keeps the question answerable instead of dropping it", async () => {
    answerAskForUser.mockRejectedValueOnce(new BudgetExceededError("d1")).mockResolvedValueOnce("applied");
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "ask" });
    sent.length = 0;

    expect(await onAskText(bot, CHAT, "u1", "Alice")).toBe(true);
    expect(sent).toEqual(["budgetReached", "Your name?"]); // refusal, then the field re-offered

    // Once the window rolls over, the next reply is captured and submitted again.
    expect(await onAskText(bot, CHAT, "u1", "Alice")).toBe(true);
    expect(answerAskForUser).toHaveBeenCalledTimes(2);
    expect(answerAskForUser).toHaveBeenLastCalledWith("u1", { messageId: "m1", action: "submit", values: { q: "Alice" } });
    expect(sent.at(-1)).toBe("answered");
  });
});

describe("telegram ask-collect — retryable refusals", () => {
  it("keeps the question answerable when the chat is busy, instead of asking for an answer it can no longer take", async () => {
    answerAskForUser.mockResolvedValueOnce("busy").mockResolvedValueOnce("applied");
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "ask" });
    sent.length = 0;

    expect(await onAskText(bot, CHAT, "u1", "Alice")).toBe(true);
    expect(sent).toEqual(["busy", "Your name?"]);

    // The next reply is still captured by the question, not sent as a new chat turn.
    expect(await onAskText(bot, CHAT, "u1", "Alice")).toBe(true);
    expect(answerAskForUser).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toBe("answered");
  });

  it("says to slow down on the flood guard's refusal and keeps the question answerable", async () => {
    answerAskForUser.mockRejectedValueOnce(new AppError("Too many messages — please slow down.", 429, "RATE_LIMITED"));
    await startAskCollection(bot, CHAT, { userId: "u1", messageId: "m1", form: oneTextField, kind: "ask" });
    sent.length = 0;

    expect(await onAskText(bot, CHAT, "u1", "Alice")).toBe(true);
    expect(sent).toEqual(["tooFast", "Your name?"]);
  });
});
