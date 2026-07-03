import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { composeConfirmPreview, composeDraft, composeError, composeFinal, draftIdFrom, makeDeliverySink } from "../delivery";
import { getTranslator } from "@/lib/i18n/translator";

const uk = getTranslator("uk", "telegram");
const en = getTranslator("en", "telegram");

describe("composeDraft", () => {
  it("uses a native <tg-thinking> block while reasoning with no answer yet", () => {
    // No reasoning text yet → localized placeholder.
    expect(composeDraft("", "", { kind: "thinking" }, uk)).toEqual({ html: "<tg-thinking>думаю…</tg-thinking>" });
    // Live reasoning text fills the block.
    expect(composeDraft("", "Зважую варіанти", { kind: "thinking" }, uk)).toEqual({
      html: "<tg-thinking>Зважую варіанти</tg-thinking>",
    });
    // HTML-significant chars in reasoning are escaped (markdown isn't parsed in tg-thinking).
    expect(composeDraft("", "a < b & c", { kind: "thinking" }, uk)).toEqual({
      html: "<tg-thinking>a &lt; b &amp; c</tg-thinking>",
    });
  });
  it("shows the friendly tool label (and detail) in the thinking block when nothing is written yet", () => {
    expect(composeDraft("", "", { kind: "tool", label: "Виконання команди…", detail: "ls -la" }, uk)).toEqual({
      html: "<tg-thinking>🔧 Виконання команди… — ls -la</tg-thinking>",
    });
    expect(composeDraft("", "", { kind: "tool", label: "Створення logo.svg…" }, uk)).toEqual({
      html: "<tg-thinking>🔧 Створення logo.svg…</tg-thinking>",
    });
  });
  it("content wins once any answer text exists — no thinking/tool block jumps in above it", () => {
    // Reasoning continues (thinking-again after a tool) but the live view stays
    // the clean answer — the reasoning is kept for the final <details>, not the draft.
    expect(composeDraft("Привіт", "Зважую варіанти", undefined, uk)).toEqual({ markdown: "Привіт" });
    // A tool running mid-answer doesn't float a `> 🔧` line above the streamed text.
    expect(composeDraft("partial", "", { kind: "tool", label: "Виконання команди…" }, uk)).toEqual({
      markdown: "partial",
    });
    // Plain answer, no reasoning, no step.
    expect(composeDraft("the answer", "", undefined, uk)).toEqual({ markdown: "the answer" });
  });
});

describe("composeConfirmPreview", () => {
  // The confirm preview is part of the security-boundary contract: whatever the
  // user must SEE before approving (the diff, the impact warning, a skill's full
  // body) must survive into BOTH the rich markdown and the plain-text fallback —
  // a channel that drops the impact line lets someone approve a change blind.
  it("carries the before→after diff into both markdown and plain", () => {
    const { markdown, plain } = composeConfirmPreview(
      { title: "Sandbox network", before: "Isolated", after: "Network access" },
      en,
    );
    expect(markdown).toContain("Isolated → Network access");
    expect(plain).toContain("Isolated → Network access");
  });

  it("shows only the new value when there is no meaningful 'before'", () => {
    const { markdown, plain } = composeConfirmPreview(
      { title: "Add connector", before: "", after: "Grok" },
      en,
    );
    expect(markdown).not.toContain("→");
    expect(markdown).toContain("Grok");
    expect(plain).toContain("Grok");
  });

  it("carries the impact warning into both markdown and plain (never approved blind)", () => {
    const { markdown, plain } = composeConfirmPreview(
      {
        title: "Block private provider URLs",
        before: "Enabled",
        after: "Disabled",
        impact: "Turning this off weakens SSRF protection.",
      },
      en,
    );
    expect(markdown).toContain("Turning this off weakens SSRF protection.");
    expect(plain).toContain("Turning this off weakens SSRF protection.");
  });

  it("carries a skill body (the full text being approved) into both markdown and plain", () => {
    const { markdown, plain } = composeConfirmPreview(
      { title: "Add skill", before: "", after: "pirate-mode", body: "Always answer like a pirate." },
      en,
    );
    expect(markdown).toContain("Always answer like a pirate.");
    expect(plain).toContain("Always answer like a pirate.");
  });

  it("escapes HTML-significant characters in the markdown preview", () => {
    const { markdown } = composeConfirmPreview(
      { title: "Name <x>", before: "a", after: "b & c" },
      en,
    );
    expect(markdown).toContain("&lt;x&gt;");
    expect(markdown).toContain("b &amp; c");
  });
});

describe("composeFinal", () => {
  // The turn summary is a FOOTER, not a header: the streamed draft (the bare
  // answer) must remain a strict text PREFIX of the final message, so clients
  // adopt the draft with an append-only "typing out" animation instead of
  // repainting the whole bubble from scratch.
  it("appends a collapsed tool log with correct plural grammar (uk)", () => {
    expect(composeFinal("Готово.", "", 1, 3000, uk)).toBe("Готово.\n\n> ✅ 1 інструмент · 3с");
    expect(composeFinal("Готово.", "", 2, 12_300, uk)).toBe("Готово.\n\n> ✅ 2 інструменти · 12с");
    expect(composeFinal("Готово.", "", 5, 9000, uk)).toBe("Готово.\n\n> ✅ 5 інструментів · 9с");
  });
  it("localizes the log for English", () => {
    expect(composeFinal("Done.", "", 1, 3000, en)).toBe("Done.\n\n> ✅ 1 tool · 3s");
    expect(composeFinal("Done.", "", 2, 12_000, en)).toBe("Done.\n\n> ✅ 2 tools · 12s");
  });
  it("returns the bare answer when no tools ran and there's no reasoning", () => {
    expect(composeFinal("Just chatting.", "", 0, 4000, en)).toBe("Just chatting.");
  });
  it("folds reasoning into a collapsed <details> with a Grok-style 'reasoned for' summary", () => {
    expect(composeFinal("Готово.", "Зважую варіанти", 2, 6000, uk)).toBe(
      "Готово.\n\n<details><summary>💭 Розмірковування протягом 6s</summary>\n\nЗважую варіанти\n\n</details>",
    );
  });
  it("uses the reasoning summary even when no tools ran", () => {
    expect(composeFinal("Hi.", "thought it through", 0, 1000, en)).toBe(
      "Hi.\n\n<details><summary>💭 Reasoned for 1s</summary>\n\nthought it through\n\n</details>",
    );
  });
  it("prefers the reasoning-phase duration over the whole-turn elapsed", () => {
    // 30s turn, but only 5s spent reasoning before the answer began.
    expect(composeFinal("Done.", "thinking", 2, 30_000, en, 5000)).toBe(
      "Done.\n\n<details><summary>💭 Reasoned for 5s</summary>\n\nthinking\n\n</details>",
    );
  });
  it("escapes angle brackets in the reasoning so they aren't read as tags", () => {
    expect(composeFinal("ok", "a < b && </details> c", 0, 0, en)).toBe(
      "ok\n\n<details><summary>💭 Reasoned for 0s</summary>\n\na &lt; b &amp;&amp; &lt;/details&gt; c\n\n</details>",
    );
  });
  it("keeps the streamed draft a strict prefix of the final (append-only convergence)", () => {
    const body = "Стрімлена відповідь.";
    expect(composeFinal(body, "думав", 3, 9000, uk, 2000).startsWith(body)).toBe(true);
    expect(composeFinal(body, "", 3, 9000, uk).startsWith(body)).toBe(true);
  });
});

describe("composeError", () => {
  it("shows only the calm notice to non-admins", () => {
    expect(composeError("The assistant is busy. Try again soon.", "429 rate limited", false, en)).toBe(
      "⚠️ The assistant is busy. Try again soon.",
    );
  });
  it("adds a collapsed, escaped technical detail for admins", () => {
    expect(composeError("Couldn't reach the AI service.", "fetch failed <host> & port", true, en)).toBe(
      "⚠️ Couldn't reach the AI service.\n\n<details><summary>Technical details</summary>\n\n```\nfetch failed &lt;host&gt; &amp; port\n```\n\n</details>",
    );
  });
  it("omits the detail block when there's nothing extra to show", () => {
    expect(composeError("Same thing", "Same thing", true, en)).toBe("⚠️ Same thing");
    expect(composeError("No detail", undefined, true, en)).toBe("⚠️ No detail");
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
    sink.push("a", "", { kind: "thinking" });
    sink.push("ab", "", { kind: "thinking" });
    sink.push("abc", "", undefined);

    await vi.advanceTimersByTimeAsync(900);

    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);
    const [chatId, , richMessage] = api.sendRichMessageDraft.mock.calls[0];
    expect(chatId).toBe(42);
    expect(richMessage.markdown).toBe("abc"); // latest, no reasoning, status cleared
  });

  it("persists the final answer via sendRichMessage and cancels pending drafts", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 7, locale: "uk" });
    sink.push("draft text", "", { kind: "thinking" });
    await sink.finish({ status: "completed", text: "final answer", toolCount: 1, elapsedMs: 3000 });

    // The pending draft timer must not fire after finish.
    await vi.advanceTimersByTimeAsync(2000);

    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe(
      "final answer\n\n> ✅ 1 інструмент · 3с",
    );
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
  });

  it("bridges the final into the draft (same id, exact final text) before persisting it", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 30, locale: "uk" });
    sink.push("відповідь", "", undefined);
    await vi.advanceTimersByTimeAsync(900); // the draft actually reached Telegram

    await sink.finish({ status: "completed", text: "відповідь", toolCount: 1, elapsedMs: 3000 });

    // Clients adopt a streamed draft into the arriving real message by matching
    // text prefixes. The bridge re-sends the draft with the exact final
    // markdown first, so adoption is a clean full match (and covers finals
    // that DON'T extend the draft, e.g. the capability notice or an error).
    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(2);
    const [, streamedId] = api.sendRichMessageDraft.mock.calls[0];
    const [, bridgeId, bridgeBody] = api.sendRichMessageDraft.mock.calls[1];
    const finalMarkdown = api.sendRichMessage.mock.calls[0][1].markdown;
    expect(bridgeId).toBe(streamedId);
    expect(bridgeBody.markdown).toBe(finalMarkdown);
    expect(finalMarkdown).toBe("відповідь\n\n> ✅ 1 інструмент · 3с");
    // The bridge must land strictly before the final message.
    expect(api.sendRichMessageDraft.mock.invocationCallOrder[1]).toBeLessThan(
      api.sendRichMessage.mock.invocationCallOrder[0],
    );
  });

  it("waits out an in-flight draft update so the final can never be overtaken by it", async () => {
    let release!: (v: true) => void;
    api.sendRichMessageDraft.mockImplementationOnce(
      () => new Promise<true>((r) => { release = r; }),
    );
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 31, locale: "uk" });
    sink.push("partial", "", undefined);
    await vi.advanceTimersByTimeAsync(900); // dispatches the draft; it hangs on the wire

    const finishing = sink.finish({ status: "completed", text: "done", toolCount: 0, elapsedMs: 100 });
    for (let i = 0; i < 5; i++) await Promise.resolve(); // let finish() reach its await
    // A draft processed by Telegram AFTER the final re-creates the streaming
    // bubble client-side for ~30s — the final must wait for the straggler.
    expect(api.sendRichMessage).not.toHaveBeenCalled();

    release(true);
    await finishing;
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
  });

  it("kills the draft keepalive permanently once finished (no orphaned re-sends)", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 21, locale: "uk" });
    sink.push("partial", "", { kind: "thinking" });
    await vi.advanceTimersByTimeAsync(900); // first draft flushes → arms the keepalive
    expect(api.sendRichMessageDraft).toHaveBeenCalledTimes(1);

    await sink.finish({ status: "completed", text: "done", toolCount: 0, elapsedMs: 100 });
    api.sendRichMessageDraft.mockClear();

    // Long past the keepalive interval: the loop must be dead, not re-pushing the
    // (already-answered) draft — the orphaned-keepalive duplication bug.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.sendRichMessageDraft).not.toHaveBeenCalled();
  });

  it("finish is idempotent — a second call delivers nothing", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 22, locale: "uk" });
    await sink.finish({ status: "completed", text: "only once", toolCount: 0, elapsedMs: 100 });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    await sink.finish({ status: "completed", text: "only once", toolCount: 0, elapsedMs: 100 });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1); // no duplicate delivery
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

  it("finish caps a tools-only reply with a notifying footer", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 12, locale: "uk" });
    await sink.finish({ status: "completed", text: "", toolCount: 3, elapsedMs: 5000 });
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe("> ✅ 3 інструменти · 5с");
    expect(api.sendRichMessage.mock.calls[0][2]).toBeUndefined(); // final pings
  });

  it("attaches Approve/Reject buttons (keyed to the messageId) when the turn suspended for approval", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 77, locale: "en" });
    await sink.finish({
      status: "completed", text: "", toolCount: 1, elapsedMs: 1000,
      approval: { messageId: "msg123", title: "Sandbox network", before: "Isolated", after: "Network access" },
    });
    const opts = api.sendRichMessage.mock.calls[0][2];
    const rows = opts.reply_markup.inline_keyboard;
    expect(rows[0][0].callback_data).toBe("ma:msg123"); // approve → resume this turn
    expect(rows[0][1].callback_data).toBe("mr:msg123"); // reject → resume with a denial
    // The before→after preview rides along so the Telegram user sees what they approve.
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toContain("Isolated → Network access");
  });

  it("persists the whole answer (reasoning folded into <details>) as one final message", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 13, locale: "uk" });
    sink.push("Готово.", "Зважую варіанти", undefined);
    await sink.finish({
      status: "completed", text: "Готово.", reasoning: "Зважую варіанти",
      toolCount: 0, elapsedMs: 6000, reasoningMs: 6000,
    });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe(
      "Готово.\n\n<details><summary>💭 Розмірковування протягом 6s</summary>\n\nЗважую варіанти\n\n</details>",
    );
  });

  it("finish falls back to a no-text note when nothing was produced", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 14, locale: "uk" });
    await sink.finish({ status: "completed", text: "", toolCount: 0, elapsedMs: 1000 });
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe("_(асистент нічого не відповів)_");
  });

  it("delivers a failure in-chat, with admin detail collapsed", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 16, locale: "en" });
    await sink.finish({
      status: "failed", text: "", toolCount: 0, elapsedMs: 0,
      error: "Couldn't reach the AI service. Please try again in a moment.",
      errorDetail: "fetch failed: ECONNREFUSED", isAdmin: true,
    });
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe(
      "⚠️ Couldn't reach the AI service. Please try again in a moment.\n\n<details><summary>Technical details</summary>\n\n```\nfetch failed: ECONNREFUSED\n```\n\n</details>",
    );
  });
});
