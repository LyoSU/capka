import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { composeDraft, composeFinal, draftIdFrom, makeDeliverySink } from "../delivery";
import { getTranslator } from "@/lib/i18n/translator";

const uk = getTranslator("uk", "telegram");
const en = getTranslator("en", "telegram");

describe("composeDraft", () => {
  it("uses a native <tg-thinking> block while reasoning with no answer yet", () => {
    // No reasoning text yet → localized placeholder.
    expect(composeDraft("", { kind: "thinking" }, uk)).toEqual({ html: "<tg-thinking>думаю…</tg-thinking>" });
    // Live reasoning text fills the block.
    expect(composeDraft("", { kind: "thinking", reasoning: "Зважую варіанти" }, uk)).toEqual({
      html: "<tg-thinking>Зважую варіанти</tg-thinking>",
    });
    // HTML-significant chars in reasoning are escaped.
    expect(composeDraft("", { kind: "thinking", reasoning: "a < b & c" }, uk)).toEqual({
      html: "<tg-thinking>a &lt; b &amp; c</tg-thinking>",
    });
  });
  it("shows the friendly tool label (and detail) in the thinking block when nothing is written yet", () => {
    expect(composeDraft("", { kind: "tool", label: "Виконання команди…", detail: "ls -la" }, uk)).toEqual({
      html: "<tg-thinking>🔧 Виконання команди… — ls -la</tg-thinking>",
    });
    expect(composeDraft("", { kind: "tool", label: "Створення logo.svg…" }, uk)).toEqual({
      html: "<tg-thinking>🔧 Створення logo.svg…</tg-thinking>",
    });
  });
  it("switches to a Markdown status header once answer text is flowing", () => {
    expect(composeDraft("Привіт", { kind: "thinking", reasoning: "x" }, uk)).toEqual({
      markdown: "> 💭 _думаю…_\n\nПривіт",
    });
    expect(composeDraft("partial", { kind: "tool", label: "Виконання команди…" }, uk)).toEqual({
      markdown: "> 🔧 Виконання команди…\n\npartial",
    });
  });
  it("shows just the answer once a status clears (answering)", () => {
    expect(composeDraft("the answer", undefined, uk)).toEqual({ markdown: "the answer" });
  });
});

describe("composeFinal", () => {
  it("adds a collapsed tool log with correct plural grammar (uk)", () => {
    expect(composeFinal("Готово.", 1, 3000, uk)).toBe("> ✅ 1 інструмент · 3с\n\nГотово.");
    expect(composeFinal("Готово.", 2, 12_300, uk)).toBe("> ✅ 2 інструменти · 12с\n\nГотово.");
    expect(composeFinal("Готово.", 5, 9000, uk)).toBe("> ✅ 5 інструментів · 9с\n\nГотово.");
  });
  it("localizes the log for English", () => {
    expect(composeFinal("Done.", 1, 3000, en)).toBe("> ✅ 1 tool · 3s\n\nDone.");
    expect(composeFinal("Done.", 2, 12_000, en)).toBe("> ✅ 2 tools · 12s\n\nDone.");
  });
  it("returns the bare answer when no tools ran", () => {
    expect(composeFinal("Just chatting.", 0, 4000, en)).toBe("Just chatting.");
  });
});

describe("draftIdFrom", () => {
  it("is deterministic and never zero", () => {
    expect(draftIdFrom("tg:1:1000")).toBe(draftIdFrom("tg:1:1000"));
    expect(draftIdFrom("tg:1:1000")).toBeGreaterThan(0);
    expect(draftIdFrom("")).toBeGreaterThan(0);
  });
  it("differs for different seeds", () => {
    expect(draftIdFrom("a")).not.toBe(draftIdFrom("b"));
  });
});

// The streaming sink throttles + coalesces draft updates and persists the final
// message via the rich API. We mock the bot module the sink dynamically imports.
const api = {
  sendRichMessageDraft: vi.fn().mockResolvedValue(true),
  sendRichMessage: vi.fn().mockResolvedValue({}),
  sendMessage: vi.fn().mockResolvedValue({}),
};
vi.mock("@/lib/telegram/bot", () => ({
  getBot: vi.fn().mockResolvedValue({ api }),
}));

describe("TelegramSink streaming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.sendRichMessageDraft.mockClear();
    api.sendRichMessage.mockClear();
    api.sendMessage.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of pushes into a single draft with the latest text", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 42, locale: "uk" });
    sink.push("a", { kind: "thinking" });
    sink.push("ab", { kind: "thinking" });
    sink.push("abc", undefined);

    await vi.advanceTimersByTimeAsync(900);

    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);
    const [chatId, , richMessage] = api.sendRichMessageDraft.mock.calls[0];
    expect(chatId).toBe(42);
    expect(richMessage.markdown).toBe("abc"); // latest, status cleared
  });

  it("persists the final answer via sendRichMessage and cancels pending drafts", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 7, locale: "uk" });
    sink.push("draft text", { kind: "thinking" });
    await sink.finish({ status: "completed", text: "final answer", toolCount: 1, elapsedMs: 3000 });

    // The pending draft timer must not fire after finish.
    await vi.advanceTimersByTimeAsync(2000);

    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe(
      "> ✅ 1 інструмент · 3с\n\nfinal answer",
    );
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
  });

  it("falls back to plain chunks when rich send is rejected", async () => {
    api.sendRichMessage.mockRejectedValueOnce(new Error("400: can't parse rich message"));
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 9, locale: "en" });
    await sink.finish({ status: "completed", text: "hello", toolCount: 0, elapsedMs: 100 });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][1]).toBe("hello");
  });

  it("persists nothing when the task was cancelled", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 5, locale: "uk" });
    await sink.finish({ status: "cancelled", text: "", toolCount: 0, elapsedMs: 50 });
    expect(api.sendRichMessage).not.toHaveBeenCalled();
  });
});
