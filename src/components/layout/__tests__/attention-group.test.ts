import { describe, it, expect } from "vitest";
import { splitAttention } from "@/components/layout/app-sidebar";

/**
 * The "needs you" group is carved out of the same list every other section
 * renders from, so the two things that can go wrong are a chat appearing twice
 * and a chat appearing while the model is still working on it.
 */
const chat = (over: Partial<Parameters<typeof splitAttention>[0][number]> & { id: string }) => ({
  title: null,
  projectId: null,
  pinned: false,
  archived: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: "web",
  visibility: null,
  shareToken: null,
  ...over,
});

describe("splitAttention", () => {
  it("moves a waiting chat into the bucket and out of the rest", () => {
    const list = [
      chat({ id: "waiting", attention: { kind: "approval", since: "2026-01-01T10:00:00.000Z" } }),
      chat({ id: "calm" }),
    ];
    const { attention, rest } = splitAttention(list);
    expect(attention.map((c) => c.id)).toEqual(["waiting"]);
    expect(rest.map((c) => c.id)).toEqual(["calm"]);
  });

  it("keeps a running chat out of the bucket, and leaves it in the rest", () => {
    const list = [
      chat({ id: "running", running: true, attention: { kind: "ask", since: "2026-01-01T10:00:00.000Z" } }),
    ];
    const { attention, rest } = splitAttention(list);
    expect(attention).toEqual([]);
    expect(rest.map((c) => c.id)).toEqual(["running"]);
  });

  it("excludes archived chats and orders the bucket by updatedAt, newest first", () => {
    const at = { kind: "failed" as const, since: "2026-01-01T10:00:00.000Z" };
    const list = [
      chat({ id: "older", updatedAt: "2026-01-01T08:00:00.000Z", attention: at }),
      chat({ id: "newer", updatedAt: "2026-01-02T08:00:00.000Z", attention: at }),
      chat({ id: "archived", archived: true, attention: at }),
    ];
    const { attention, rest } = splitAttention(list);
    expect(attention.map((c) => c.id)).toEqual(["newer", "older"]);
    expect(rest.map((c) => c.id)).toEqual(["archived"]);
  });
});
