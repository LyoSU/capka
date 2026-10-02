import { describe, it, expect } from "vitest";
import { deriveTabState, prefixTitle } from "@/lib/tab-state";

const none = new Set<string>();
const away = { activeChatId: null, doneWhileAway: false, fresh: none };

describe("deriveTabState", () => {
  it("is idle with nothing going on", () => {
    expect(deriveTabState([{ id: "a" }], away)).toEqual({ kind: "idle", count: 0 });
  });

  it("puts a chat waiting on the person above one that is working", () => {
    const s = deriveTabState(
      [{ id: "a", running: true }, { id: "b", attention: { kind: "ask" } }, { id: "c" }],
      { ...away, fresh: new Set(["c"]) },
    );
    expect(s).toEqual({ kind: "needs", count: 2 });
  });

  it("does not count a running chat as waiting even if its old mark lingers", () => {
    expect(deriveTabState([{ id: "a", running: true, attention: { kind: "ask" } }], away)).toEqual({ kind: "working", count: 0 });
  });

  it("ignores archived chats and the open chat", () => {
    const s = deriveTabState(
      [{ id: "a", archived: true }, { id: "b" }],
      { activeChatId: "b", doneWhileAway: false, fresh: new Set(["a", "b"]) },
    );
    expect(s).toEqual({ kind: "idle", count: 0 });
  });

  it("counts a reply that finished in the open chat while the tab was hidden", () => {
    expect(deriveTabState([{ id: "b" }], { activeChatId: "b", doneWhileAway: true, fresh: none })).toEqual({ kind: "done", count: 1 });
  });
});

it("does not count a backlog chat that only the server calls unread", () => {
  // e.g. an automation chat never opened: the sidebar dot shows it, the tab does not.
  expect(deriveTabState([{ id: "auto" }], away)).toEqual({ kind: "idle", count: 0 });
});

describe("prefixTitle", () => {
  it("writes and replaces only its own count prefix", () => {
    const once = prefixTitle("Budget — Capka", { kind: "needs", count: 2 });
    expect(once).toBe("(2) Budget — Capka");
    expect(prefixTitle(once, { kind: "working", count: 1 })).toBe("Budget — Capka");
    expect(prefixTitle(once, { kind: "idle", count: 0 })).toBe("Budget — Capka");
    expect(prefixTitle(prefixTitle(once, { kind: "done", count: 3 }), { kind: "done", count: 3 })).toBe("(3) Budget — Capka");
  });

  it("strips the glyph prefix earlier builds wrote", () => {
    expect(prefixTitle("\u25CF (2) Budget", { kind: "idle", count: 0 })).toBe("Budget");
    expect(prefixTitle("\u27F3 Budget", { kind: "done", count: 1 })).toBe("(1) Budget");
  });

  it("strips the bare count prefix older builds wrote", () => {
    expect(prefixTitle("(4) Capka", { kind: "idle", count: 0 })).toBe("Capka");
  });
});
