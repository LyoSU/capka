import { describe, it, expect } from "vitest";
import { formatSource } from "../memory-topics";

// Copy is looked up by key; the test asserts WHICH key and WHICH values, never the
// prose — the prose lives in messages/*.json and is translated.
const t = (key: string, values?: Record<string, unknown>) => `${key}(${JSON.stringify(values ?? {})})`;

describe("formatSource", () => {
  it("names one chat and the day", () => {
    const out = formatSource({ kind: "chat", chatId: "c1", chatTitle: "Q2 report", at: "2026-08-14T09:00:00.000Z" }, "en", t);
    expect(out).toContain("fromChat(");
    expect(out).toContain("Q2 report");
  });

  it("falls back to a name for an untitled chat rather than printing nothing", () => {
    expect(formatSource({ kind: "chat", chatId: "c1", chatTitle: null, at: "2026-08-14T09:00:00.000Z" }, "en", t))
      .toContain("untitledChat");
  });

  it("counts several conversations and names the most recent", () => {
    const out = formatSource(
      { kind: "chats", count: 3, latest: { chatId: "c1", chatTitle: "Q2 report", at: "2026-08-14T09:00:00.000Z" } }, "en", t);
    expect(out).toContain("fromChats(");
    expect(out).toContain('"count":3');
  });

  it("says where a carried-over fact came from", () => {
    expect(formatSource({ kind: "legacy" }, "en", t)).toContain("fromLegacy(");
  });

  it("does not guess when the conversation is gone", () => {
    expect(formatSource({ kind: "unknown" }, "en", t)).toContain("fromUnknown(");
  });

  it("formats the day in the reader's language, not the server's", () => {
    // The reason `locale` is a parameter at all. Both must name the same day; only the
    // month name may differ, and it must differ — a hardcoded "en-US" would return the
    // same string for both and this is the only assertion that would notice.
    const source = { kind: "chat", chatId: "c1", chatTitle: "x", at: "2026-08-14T09:00:00.000Z" } as const;
    const en = formatSource(source, "en", t);
    const uk = formatSource(source, "uk", t);
    expect(en).toContain("14");
    expect(uk).toContain("14");
    expect(en).not.toBe(uk);
  });
});

describe("topicLabel", () => {
  it("prefers the copy for a known key over the stored title", async () => {
    const { topicLabel } = await import("../memory-topics");
    const topic = { id: "n1", topicKey: "general", title: "Something a rename left behind",
      lastUpdatedAt: null, facts: [] };
    expect(topicLabel(topic, (k) => `copy:${k}`, (k) => k === "topics.general")).toBe("copy:topics.general");
  });

  it("falls back to the stored title for a key nobody has copy for", async () => {
    const { topicLabel } = await import("../memory-topics");
    const topic = { id: "n1", topicKey: "suppliers", title: "Suppliers", lastUpdatedAt: null, facts: [] };
    expect(topicLabel(topic, (k) => `copy:${k}`, () => false)).toBe("Suppliers");
  });

  it("falls back to the stored title for a note with no key at all", async () => {
    const { topicLabel } = await import("../memory-topics");
    const topic = { id: "n1", topicKey: null, title: "Untouched by the migration",
      lastUpdatedAt: null, facts: [] };
    expect(topicLabel(topic, (k) => `copy:${k}`, () => true)).toBe("Untouched by the migration");
  });
});
