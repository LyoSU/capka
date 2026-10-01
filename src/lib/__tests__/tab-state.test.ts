import { describe, it, expect } from "vitest";
import { deriveTabState, prefixTitle } from "@/lib/tab-state";

const away = { activeChatId: null, doneWhileAway: false };

describe("deriveTabState", () => {
  it("is idle with nothing going on", () => {
    expect(deriveTabState([{ id: "a" }], away)).toEqual({ kind: "idle", count: 0 });
  });

  it("puts a chat waiting on the person above one that is working", () => {
    const s = deriveTabState(
      [{ id: "a", running: true }, { id: "b", attention: { kind: "ask" } }, { id: "c", unread: true }],
      away,
    );
    expect(s).toEqual({ kind: "needs", count: 2 });
  });

  it("does not count a running chat as waiting even if its old mark lingers", () => {
    expect(deriveTabState([{ id: "a", running: true, attention: { kind: "ask" } }], away)).toEqual({ kind: "working", count: 0 });
  });

  it("ignores archived chats and the open chat's unread flag", () => {
    const s = deriveTabState(
      [{ id: "a", unread: true, archived: true }, { id: "b", unread: true }],
      { activeChatId: "b", doneWhileAway: false },
    );
    expect(s).toEqual({ kind: "idle", count: 0 });
  });

  it("counts a reply that finished in the open chat while the tab was hidden", () => {
    expect(deriveTabState([{ id: "b" }], { activeChatId: "b", doneWhileAway: true })).toEqual({ kind: "done", count: 1 });
  });
});

describe("prefixTitle", () => {
  it("writes and replaces only its own prefix", () => {
    const once = prefixTitle("Budget — Capka", { kind: "needs", count: 2 });
    expect(once).toBe("● (2) Budget — Capka");
    expect(prefixTitle(once, { kind: "working", count: 1 })).toBe("⟳ Budget — Capka");
    expect(prefixTitle(once, { kind: "idle", count: 0 })).toBe("Budget — Capka");
    expect(prefixTitle(prefixTitle(once, { kind: "done", count: 3 }), { kind: "done", count: 3 })).toBe("✓ (3) Budget — Capka");
  });

  it("strips the bare count prefix older builds wrote", () => {
    expect(prefixTitle("(4) Capka", { kind: "idle", count: 0 })).toBe("Capka");
  });
});
