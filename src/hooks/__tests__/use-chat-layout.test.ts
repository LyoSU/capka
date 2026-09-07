import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CHAT_LAYOUT_PREFIX,
  MAX_CHAT_LAYOUTS,
  clearPreviewPath,
  keysToPrune,
  readChatLayout,
  writeChatLayout,
} from "@/hooks/use-chat-layout";

// A remembered panel is never worth a crash, and a store with no bound is a leak
// with a slow fuse. Both are decisions this module makes on its own, so both are
// pinned here; the restore itself needs a browser.

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const install = (store: unknown) => {
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
};

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis as Record<string, unknown>, "localStorage");
  vi.useRealTimers();
});

describe("keysToPrune", () => {
  const at = (key: string, t: number) => ({ key, at: t });

  it("keeps everything while inside the bound", () => {
    expect(keysToPrune([at("a", 3), at("b", 1)], 50)).toEqual([]);
    expect(keysToPrune([], 50)).toEqual([]);
  });

  it("drops the oldest, and only as many as it must", () => {
    const entries = [at("newest", 300), at("oldest", 100), at("middle", 200)];
    expect(keysToPrune(entries, 2)).toEqual(["oldest"]);
    expect(keysToPrune(entries, 1)).toEqual(["oldest", "middle"]);
  });

  it("an entry with no usable stamp sorts oldest — it predates the stamping", () => {
    expect(keysToPrune([at("stamped", 500), at("legacy", 0)], 1)).toEqual(["legacy"]);
  });

  it("does not mutate the list it was given", () => {
    const entries = [at("b", 2), at("a", 1)];
    keysToPrune(entries, 1);
    expect(entries.map((e) => e.key)).toEqual(["b", "a"]);
  });
});

describe("per-chat layout", () => {
  it("round-trips the panel state and the docked file", () => {
    const store = fakeStorage();
    install(store);
    writeChatLayout("c1", { workspaceOpen: true, previewPath: "reports/q3.md" });
    expect(readChatLayout("c1")).toEqual({ workspaceOpen: true, previewPath: "reports/q3.md" });
    expect(store.map.has(`${CHAT_LAYOUT_PREFIX}c1`)).toBe(true);
  });

  it("a chat with no entry reads as null, so the caller's defaults stand", () => {
    install(fakeStorage());
    expect(readChatLayout("never-touched")).toBe(null);
  });

  it("a chat back at its defaults stores nothing rather than storing the defaults", () => {
    const store = fakeStorage();
    install(store);
    writeChatLayout("c1", { workspaceOpen: true, previewPath: "a.md" });
    writeChatLayout("c1", { workspaceOpen: false, previewPath: null });
    expect(store.map.has(`${CHAT_LAYOUT_PREFIX}c1`)).toBe(false);
    expect(readChatLayout("c1")).toBe(null);
  });

  it("forgetting a file that is gone keeps the column the user left open", () => {
    install(fakeStorage());
    writeChatLayout("c1", { workspaceOpen: true, previewPath: "deleted.csv" });
    clearPreviewPath("c1");
    expect(readChatLayout("c1")).toEqual({ workspaceOpen: true, previewPath: null });
  });

  it("a corrupt or half-written entry reads as null instead of throwing", () => {
    install(fakeStorage({ [`${CHAT_LAYOUT_PREFIX}c1`]: "{not json", [`${CHAT_LAYOUT_PREFIX}c2`]: '{"previewPath":7}' }));
    expect(readChatLayout("c1")).toBe(null);
    expect(readChatLayout("c2")).toEqual({ workspaceOpen: false, previewPath: null });
  });

  it("a write keeps only the most recent entries, and touches nothing else in storage", () => {
    const store = fakeStorage({ "capka.layout.sidebar": "312", "capka:draft:c1": "hello" });
    install(store);
    vi.useFakeTimers();
    for (let i = 0; i < MAX_CHAT_LAYOUTS + 10; i++) {
      vi.setSystemTime(new Date(1_700_000_000_000 + i * 1000));
      writeChatLayout(`chat-${i}`, { workspaceOpen: true, previewPath: null });
    }
    const layoutKeys = [...store.map.keys()].filter((k) => k.startsWith(CHAT_LAYOUT_PREFIX));
    expect(layoutKeys).toHaveLength(MAX_CHAT_LAYOUTS);
    // The ten oldest went; the newest stayed.
    expect(readChatLayout("chat-0")).toBe(null);
    expect(readChatLayout("chat-9")).toBe(null);
    expect(readChatLayout("chat-10")).not.toBe(null);
    expect(readChatLayout(`chat-${MAX_CHAT_LAYOUTS + 9}`)).not.toBe(null);
    // Widths and drafts share the prefix's neighbourhood and must survive it.
    expect(store.map.get("capka.layout.sidebar")).toBe("312");
    expect(store.map.get("capka:draft:c1")).toBe("hello");
  });

  it("survives storage that throws (private window, blocked site data)", () => {
    install({
      get length(): number {
        throw new Error("denied");
      },
      key: () => {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(readChatLayout("c1")).toBe(null);
    expect(() => writeChatLayout("c1", { workspaceOpen: true, previewPath: "a.md" })).not.toThrow();
    expect(() => clearPreviewPath("c1")).not.toThrow();
  });
});
