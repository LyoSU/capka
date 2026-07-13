import { describe, it, expect } from "vitest";
import { parseClaudeSnapshot, parseChatGptState, parseGrokResponses, parseGeminiTurns, normalizeImport } from "../parse";
import { MAX_IMPORT_MESSAGES, MAX_IMPORT_MESSAGE_CHARS } from "../types";

// Fixtures below use invented content but mirror the field shapes verified from
// the live services (claude.ai chat_snapshots API; chatgpt.com router loaderData;
// grok.com share_links API; gemini scraped-DOM shape). Never real conversations.

describe("parseClaudeSnapshot", () => {
  it("reconstructs text from content[] blocks and separates roles", () => {
    const raw = {
      snapshot_name: "Рецепт котлети",
      chat_messages: [
        { sender: "human", text: "", content: [{ type: "text", text: "Порадь рецепт." }], attachments: [], files: [] },
        {
          sender: "assistant",
          text: "",
          content: [
            { type: "tool_use", name: "web_search" },
            { type: "tool_result" },
            { type: "text", text: "Ось рецепт." },
          ],
          attachments: [],
          files: [],
        },
      ],
    };
    const r = parseClaudeSnapshot(raw);
    expect(r.source).toBe("claude");
    expect(r.title).toBe("Рецепт котлети");
    expect(r.messages).toEqual([
      { role: "user", content: "Порадь рецепт." },
      { role: "assistant", content: "Ось рецепт." },
    ]);
    // The assistant turn had tool blocks → rich content was dropped.
    expect(r.droppedRichContent).toBe(true);
  });

  it("flags dropped rich content for attachments/images even when text survives", () => {
    const raw = {
      snapshot_name: "x",
      chat_messages: [
        { sender: "human", content: [{ type: "text", text: "дивись фото" }], attachments: [], files: [{ file_name: "a.png" }], image_count: 1 },
      ],
    };
    const r = parseClaudeSnapshot(raw);
    expect(r.messages).toHaveLength(1);
    expect(r.droppedRichContent).toBe(true);
  });

  it("falls back to the flat text field when content[] has no text block", () => {
    const raw = { chat_messages: [{ sender: "human", text: "лише flat", content: [] }] };
    expect(parseClaudeSnapshot(raw).messages).toEqual([{ role: "user", content: "лише flat" }]);
  });

  it("skips a turn that has no text at all (pure tool turn)", () => {
    const raw = {
      chat_messages: [
        { sender: "assistant", text: "", content: [{ type: "tool_use" }, { type: "tool_result" }] },
      ],
    };
    expect(parseClaudeSnapshot(raw).messages).toHaveLength(0);
  });

  it("skips a message with an unknown sender and flags dropped content", () => {
    const raw = {
      chat_messages: [
        { sender: "human", content: [{ type: "text", text: "агов" }] },
        { sender: "moderator", content: [{ type: "text", text: "не імпортувати" }] },
      ],
    };
    const r = parseClaudeSnapshot(raw);
    expect(r.messages).toEqual([{ role: "user", content: "агов" }]);
    expect(r.droppedRichContent).toBe(true);
  });

  it("survives a garbage payload", () => {
    expect(parseClaudeSnapshot(null).messages).toEqual([]);
    expect(parseClaudeSnapshot({ chat_messages: "nope" }).messages).toEqual([]);
  });
});

describe("parseChatGptState", () => {
  const mapping = {
    n0: { id: "n0", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] } }, parent: null, children: ["n1"] },
    n1: { id: "n1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["Привіт"] } }, parent: "n0", children: ["n2"] },
    n2: { id: "n2", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Вітаю!"] } }, parent: "n1", children: ["n3"] },
    n3: { id: "n3", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Радий допомогти"] } }, parent: "n2", children: [] },
  };

  it("walks current_node → root, drops system, keeps user/assistant in order", () => {
    const r = parseChatGptState({ title: "Привітання", current_node: "n3", mapping });
    expect(r.source).toBe("chatgpt");
    expect(r.title).toBe("Привітання");
    expect(r.messages).toEqual([
      { role: "user", content: "Привіт" },
      { role: "assistant", content: "Вітаю!" },
      { role: "assistant", content: "Радий допомогти" },
    ]);
    expect(r.droppedRichContent).toBe(false);
  });

  it("follows only the branch the sharer left visible (ignores unrelated siblings)", () => {
    const branched = {
      ...mapping,
      n2b: { id: "n2b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ІНША ГІЛКА"] } }, parent: "n1", children: [] },
    };
    // current_node points at n2 → chain is n0,n1,n2; the n2b sibling is not on it.
    const r = parseChatGptState({ current_node: "n2", mapping: branched });
    expect(r.messages.map((m) => m.content)).toEqual(["Привіт", "Вітаю!"]);
  });

  it("without current_node, descends the last branch deterministically (no sibling mixing)", () => {
    const branched = {
      r0: { id: "r0", message: { author: { role: "user" }, content: { content_type: "text", parts: ["корінь"] } }, parent: null, children: ["a1", "b1"] },
      a1: { id: "a1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ПЕРША ГІЛКА"] } }, parent: "r0", children: [] },
      b1: { id: "b1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ОСТАННЯ ГІЛКА"] } }, parent: "r0", children: [] },
    };
    // No current_node → descend from root via the last child → only b1's branch.
    const r = parseChatGptState({ mapping: branched });
    expect(r.messages).toEqual([
      { role: "user", content: "корінь" },
      { role: "assistant", content: "ОСТАННЯ ГІЛКА" },
    ]);
  });

  it("returns nothing when the mapping has no root (a cycle)", () => {
    const cyclic = {
      x: { id: "x", message: { author: { role: "user" }, content: { content_type: "text", parts: ["a"] } }, parent: "y", children: ["y"] },
      y: { id: "y", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["b"] } }, parent: "x", children: ["x"] },
    };
    expect(parseChatGptState({ mapping: cyclic }).messages).toEqual([]);
  });

  it("flags rich content for a tool turn and for non-text content", () => {
    const withTool = {
      current_node: "t2",
      mapping: {
        t1: { id: "t1", message: { author: { role: "user" }, content: { content_type: "text", parts: ["зроби картинку"] } }, parent: null, children: ["t2"] },
        t2: { id: "t2", message: { author: { role: "tool" }, content: { content_type: "text", parts: ["<image>"] } }, parent: "t1", children: [] },
      },
    };
    const r = parseChatGptState(withTool);
    expect(r.droppedRichContent).toBe(true);
    expect(r.messages).toEqual([{ role: "user", content: "зроби картинку" }]);
  });

  it("survives a garbage payload", () => {
    expect(parseChatGptState(null).messages).toEqual([]);
    expect(parseChatGptState({ mapping: 5 }).messages).toEqual([]);
  });
});

describe("parseGrokResponses", () => {
  it("maps responses to roles case-insensitively and keeps the markdown message", () => {
    const raw = {
      conversation: { title: "Список покупок", conversationId: "c1" },
      responses: [
        { sender: "human", message: "Склади список." },
        { sender: "ASSISTANT", message: "Ось **список**:\n- хліб\n- молоко" },
      ],
    };
    const r = parseGrokResponses(raw);
    expect(r.source).toBe("grok");
    expect(r.title).toBe("Список покупок");
    expect(r.messages).toEqual([
      { role: "user", content: "Склади список." },
      { role: "assistant", content: "Ось **список**:\n- хліб\n- молоко" },
    ]);
    expect(r.droppedRichContent).toBe(false);
  });

  it("flags dropped rich content for any non-empty rich field (text survives)", () => {
    const raw = {
      conversation: { title: "x" },
      responses: [
        { sender: "human", message: "що там у новинах?" },
        { sender: "assistant", message: "Ось підсумок.", webSearchResults: [{ url: "https://example.test" }], xpostIds: ["p1"] },
      ],
    };
    const r = parseGrokResponses(raw);
    expect(r.messages).toHaveLength(2);
    expect(r.droppedRichContent).toBe(true);
  });

  it("skips a response with an empty message", () => {
    const raw = { responses: [{ sender: "human", message: "" }, { sender: "assistant", message: "лишень я" }] };
    const r = parseGrokResponses(raw);
    expect(r.messages).toEqual([{ role: "assistant", content: "лишень я" }]);
  });

  it("has a null title when conversation is missing, and survives garbage", () => {
    expect(parseGrokResponses({ responses: [{ sender: "human", message: "агов" }] }).title).toBeNull();
    expect(parseGrokResponses(null).messages).toEqual([]);
    expect(parseGrokResponses({ responses: "nope" }).messages).toEqual([]);
  });

  it("drops a whitespace-only or missing message, and skips an unknown sender (flagging dropped content)", () => {
    const raw = {
      responses: [
        { sender: "human", message: "   " },
        { sender: "human" },
        { sender: "system", message: "Я асистент." },
      ],
    };
    const r = parseGrokResponses(raw);
    // "system" is not in the role whitelist → dropped, not coerced to assistant.
    expect(r.messages).toEqual([]);
    expect(r.droppedRichContent).toBe(true);
  });
});

describe("parseGeminiTurns", () => {
  it("expands each turn into a user + assistant message", () => {
    const raw = {
      title: "Ідеї для подорожі",
      turns: [
        { query: "Куди поїхати навесні?", response: "Раджу:\n1. Львів\n2. Одеса" },
        { query: "А з дітьми?", response: "Тоді Карпати." },
      ],
    };
    const r = parseGeminiTurns(raw);
    expect(r.source).toBe("gemini");
    expect(r.title).toBe("Ідеї для подорожі");
    expect(r.messages).toEqual([
      { role: "user", content: "Куди поїхати навесні?" },
      { role: "assistant", content: "Раджу:\n1. Львів\n2. Одеса" },
      { role: "user", content: "А з дітьми?" },
      { role: "assistant", content: "Тоді Карпати." },
    ]);
    expect(r.droppedRichContent).toBe(false);
  });

  it("skips an empty query or response side without dropping the other", () => {
    const raw = {
      turns: [
        { query: "лише питання", response: "" },
        { query: "", response: "лише відповідь" },
        { query: "", response: "" },
      ],
    };
    const r = parseGeminiTurns(raw);
    expect(r.messages).toEqual([
      { role: "user", content: "лише питання" },
      { role: "assistant", content: "лише відповідь" },
    ]);
  });

  it("passes the script's droppedRichContent flag through", () => {
    const r = parseGeminiTurns({ turns: [{ query: "фото?", response: "ось" }], droppedRichContent: true });
    expect(r.droppedRichContent).toBe(true);
  });

  it("trims the title and treats a blank one as null", () => {
    expect(parseGeminiTurns({ title: "  Подорож  ", turns: [] }).title).toBe("Подорож");
    expect(parseGeminiTurns({ title: "   ", turns: [] }).title).toBeNull();
  });

  it("survives a garbage payload", () => {
    expect(parseGeminiTurns(null).messages).toEqual([]);
    expect(parseGeminiTurns({ turns: 7 }).messages).toEqual([]);
    expect(parseGeminiTurns({ turns: ["nope", 5] }).messages).toEqual([]);
  });
});

describe("normalizeImport", () => {
  const base = { source: "claude" as const, title: "t", truncated: false, droppedRichContent: false };

  it("drops empty messages and strips control characters", () => {
    const r = normalizeImport({ ...base, messages: [
      { role: "user", content: "питання" },
      { role: "user", content: "  " },
      { role: "assistant", content: "hello\x00\x07 world\r\nsecond" },
    ] });
    expect(r.messages).toEqual([
      { role: "user", content: "питання" },
      { role: "assistant", content: "hello world\nsecond" },
    ]);
  });

  it("clips an over-long message and marks the import truncated", () => {
    const long = "a".repeat(MAX_IMPORT_MESSAGE_CHARS + 50);
    const r = normalizeImport({ ...base, messages: [{ role: "user", content: long }] });
    expect(r.truncated).toBe(true);
    expect(r.messages[0].content.length).toBeLessThanOrEqual(MAX_IMPORT_MESSAGE_CHARS + 5);
    expect(r.messages[0].content.endsWith("[…]")).toBe(true);
  });

  it("caps the message count and marks truncated", () => {
    const many = Array.from({ length: MAX_IMPORT_MESSAGES + 10 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const r = normalizeImport({ ...base, messages: many });
    expect(r.messages).toHaveLength(MAX_IMPORT_MESSAGES);
    expect(r.truncated).toBe(true);
  });

  it("preserves a title but bounds its length", () => {
    expect(normalizeImport({ ...base, title: null, messages: [] }).title).toBeNull();
    expect(normalizeImport({ ...base, title: "x".repeat(500), messages: [] }).title?.length).toBe(200);
  });

  it("drops leading assistant messages so the history starts with a user turn", () => {
    const r = normalizeImport({ ...base, messages: [
      { role: "assistant", content: "привіт наперед" },
      { role: "user", content: "питання" },
      { role: "assistant", content: "відповідь" },
    ] });
    expect(r.messages).toEqual([
      { role: "user", content: "питання" },
      { role: "assistant", content: "відповідь" },
    ]);
    expect(r.truncated).toBe(true);
  });

  it("drops everything (and marks truncated) when there is no user turn at all", () => {
    const r = normalizeImport({ ...base, messages: [
      { role: "assistant", content: "лише асистент" },
    ] });
    expect(r.messages).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it("re-checks user-first AFTER sanitize: a user turn that empties out can't leave a leading assistant", () => {
    // The user turn is non-empty in the source but sanitizes to nothing (control
    // chars only), so it's skipped and the assistant would otherwise lead.
    const r = normalizeImport({ ...base, messages: [
      { role: "user", content: "\x07\x00" },
      { role: "assistant", content: "привіт" },
    ] });
    expect(r.messages).toEqual([]);
    expect(r.truncated).toBe(true);
  });
});
