import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrammyError, HttpError } from "grammy";
import { composeConfirmPreview, composeDraft, composeError, composeFinal, composeSources, draftIdFrom, makeDeliverySink, refusedDelivery } from "../delivery";
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
    // the clean answer — mid-answer reasoning is dropped, never shown.
    expect(composeDraft("Привіт", "Зважую варіанти", undefined, uk)).toEqual({ markdown: "Привіт" });
    // A tool running mid-answer doesn't float a `> 🔧` line above the streamed text.
    expect(composeDraft("partial", "", { kind: "tool", label: "Виконання команди…" }, uk)).toEqual({
      markdown: "partial",
    });
    // Plain answer, no reasoning, no step.
    expect(composeDraft("the answer", "", undefined, uk)).toEqual({ markdown: "the answer" });
  });
});

describe("composeSources", () => {
  it("renders one quoted [N] line per source, flattening a hostile title", () => {
    const { markdown, plain } = composeSources(
      [
        { n: 1, title: "Kyiv - Wikipedia", url: "https://en.wikipedia.org/wiki/Kyiv" },
        { n: 2, title: "spoof](https://evil.example) *bold*\nnewline", url: "https://real.example/page" },
      ],
      uk,
    );
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("> Джерела:");
    expect(lines[1]).toBe("> [1] Kyiv - Wikipedia — https://en.wikipedia.org/wiki/Kyiv");
    // The title lost its brackets, link syntax, emphasis, and newline — one plain
    // line (the [2] prefix is ours; everything after it must be markup-free).
    expect(lines[2].startsWith("> [2] spoof")).toBe(true);
    expect(lines[2].slice("> [2] ".length)).not.toMatch(/[[\]()*]/);
    expect(lines[2]).toContain("https://real.example/page");
    expect(lines).toHaveLength(3);
    // The plain fallback carries the same flat lines, unquoted.
    expect(plain).toContain("[1] Kyiv - Wikipedia — https://en.wikipedia.org/wiki/Kyiv");
    expect(plain).not.toContain("> ");
  });

  it("collapses past five sources behind an expandable details block", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ n: i + 1, title: `T${i + 1}`, url: `https://s.example/${i + 1}` }));
    const { markdown, plain } = composeSources(many, uk);
    expect(markdown.startsWith("<details><summary>Джерела: (6)</summary>")).toBe(true);
    expect(markdown).toContain("[6] T6 — https://s.example/6");
    // Plain fallback never hides anything behind markup it can't express.
    expect(plain).not.toContain("<details>");
    expect(plain).toContain("[6] T6 — https://s.example/6");
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

  it("composes the localized title for a gated tool call (governance \"ask\" — no staged diff)", () => {
    const { markdown, plain } = composeConfirmPreview(
      { title: "", tool: "tavily: search", before: "", after: "", body: "{\n  \"query\": \"weather kyiv\"\n}" },
      uk,
    );
    expect(markdown).toContain("Дозволити цю дію?");
    expect(markdown).toContain("tavily: search");
    expect(plain).toContain("tavily: search");
    expect(plain).toContain("weather kyiv"); // the arguments survive into the fallback too
  });

  it("a truncated gated call points at the web card in both markdown and plain (its buttons are withheld)", () => {
    const { markdown, plain } = composeConfirmPreview(
      { title: "", tool: "crm: bulk_update", before: "", after: "", body: "{ \"ids\": [1,2,3 …", truncated: true },
      uk,
    );
    for (const out of [markdown, plain]) {
      expect(out).toContain("відкрийте Capka у браузері");
    }
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
    expect(composeFinal("Готово.", 1, 3000, uk)).toBe("Готово.\n\n> ✅ 1 інструмент · 3с");
    expect(composeFinal("Готово.", 2, 12_300, uk)).toBe("Готово.\n\n> ✅ 2 інструменти · 12с");
    expect(composeFinal("Готово.", 5, 9000, uk)).toBe("Готово.\n\n> ✅ 5 інструментів · 9с");
  });
  it("localizes the log for English", () => {
    expect(composeFinal("Done.", 1, 3000, en)).toBe("Done.\n\n> ✅ 1 tool · 3s");
    expect(composeFinal("Done.", 2, 12_000, en)).toBe("Done.\n\n> ✅ 2 tools · 12s");
  });
  it("returns the bare answer when no tools ran", () => {
    expect(composeFinal("Just chatting.", 0, 4000, en)).toBe("Just chatting.");
  });
  it("never folds reasoning into the final message — thinking is draft-only", () => {
    // Even when the turn reasoned, the final carries only the answer (+ tool log).
    expect(composeFinal("Hi.", 0, 1000, en)).toBe("Hi.");
    expect(composeFinal("Готово.", 2, 6000, uk)).toBe("Готово.\n\n> ✅ 2 інструменти · 6с");
  });
  it("keeps the streamed draft a strict prefix of the final (append-only convergence)", () => {
    const body = "Стрімлена відповідь.";
    expect(composeFinal(body, 3, 9000, uk).startsWith(body)).toBe(true);
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
    // A real API refusal (`ok: false`), not any thrown error: see refusedDelivery —
    // a bare Error proves nothing about whether the message was posted.
    api.sendRichMessage.mockRejectedValueOnce(apiError(400, "can't parse rich message"));
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

  it("persists the whole answer as one final message, dropping the reasoning", async () => {
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 13, locale: "uk" });
    sink.push("Готово.", "Зважую варіанти", undefined);
    await sink.finish({
      status: "completed", text: "Готово.", reasoning: "Зважую варіанти",
      toolCount: 0, elapsedMs: 6000, reasoningMs: 6000,
    });
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(api.sendRichMessage.mock.calls[0][1].markdown).toBe("Готово.");
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

/**
 * Sending is an emission: once it leaves, this process can't undo it and can't
 * always tell whether it arrived. So the plain-text fallback may only run when
 * Telegram's own answer proves nothing was posted — otherwise one turn becomes two
 * messages in the user's chat.
 */
const apiError = (code: number, description: string) =>
  new GrammyError(`Call to 'sendRichMessage' failed! (${code}: ${description})`, { ok: false, error_code: code, description }, "sendRichMessage", {});

describe("refusedDelivery", () => {
  it("is true for an API answer that rejected the message", () => {
    expect(refusedDelivery(apiError(400, "can't parse entities"))).toBe(true);
    expect(refusedDelivery(apiError(404, "Not Found: method not found"))).toBe(true); // no rich messages on this Bot API
    expect(refusedDelivery(apiError(429, "Too Many Requests"))).toBe(true);
  });

  it("is false when the outcome is unknown", () => {
    // No answer arrived: Telegram may have posted the message and lost the response.
    expect(refusedDelivery(new HttpError("network error", new Error("ECONNRESET")))).toBe(false);
    // Same ambiguity from the far side.
    expect(refusedDelivery(apiError(500, "Internal Server Error"))).toBe(false);
    expect(refusedDelivery(new Error("something else"))).toBe(false);
  });
});

describe("TelegramSink emission safety", () => {
  beforeEach(() => {
    api.sendRichMessageDraft.mockClear();
    api.sendRichMessage.mockClear();
    api.sendMessage.mockClear();
    api.sendRichMessage.mockResolvedValue({});
  });
  afterEach(() => api.sendRichMessage.mockResolvedValue({}));

  it("falls back to plain text when Telegram rejected the markup", async () => {
    api.sendRichMessage.mockRejectedValueOnce(apiError(400, "can't parse entities"));
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 21, locale: "uk" });

    await sink.finish({ status: "completed", text: "answer", toolCount: 0, elapsedMs: 1000 });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][1]).toContain("answer");
  });

  it("does NOT re-send when the response was lost — the message may already be there", async () => {
    api.sendRichMessage.mockRejectedValueOnce(new HttpError("network error", new Error("ECONNRESET")));
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 22, locale: "uk" });

    await sink.finish({ status: "completed", text: "answer", toolCount: 0, elapsedMs: 1000 });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT re-send on a 5xx, which is the same ambiguity from the far side", async () => {
    api.sendRichMessage.mockRejectedValueOnce(apiError(500, "Internal Server Error"));
    const sink = makeDeliverySink({ platform: "telegram", telegramChatId: 23, locale: "uk" });

    await sink.finish({ status: "completed", text: "answer", toolCount: 0, elapsedMs: 1000 });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
