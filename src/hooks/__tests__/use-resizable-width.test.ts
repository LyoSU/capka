import { describe, it, expect, afterEach, vi } from "vitest";
import { clampWidth, readStoredWidth, writeStoredWidth } from "@/hooks/use-resizable-width";

// The hook itself needs a DOM; its decisions do not. Everything that can be
// wrong about a remembered width — the clamp, the round-trip through storage,
// and forgetting it again — is a pure function, and that is what is tested here.

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

const install = (store: unknown) => {
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });
};

describe("clampWidth", () => {
  it("keeps a width inside the range and rounds to whole pixels", () => {
    expect(clampWidth(300, 224, 448)).toBe(300);
    expect(clampWidth(300.6, 224, 448)).toBe(301);
    expect(clampWidth(100, 224, 448)).toBe(224);
    expect(clampWidth(900, 224, 448)).toBe(448);
  });

  it("lets the minimum win when the ceiling drops below it", () => {
    // A window narrow enough that the chat's own floor eats the whole ceiling.
    expect(clampWidth(400, 320, 120)).toBe(320);
    expect(clampWidth(100, 320, 120)).toBe(320);
  });

  it("falls back to the minimum for a width that is not a number", () => {
    expect(clampWidth(Number.NaN, 224, 448)).toBe(224);
    expect(clampWidth(Number.POSITIVE_INFINITY, 224, 448)).toBe(224);
  });
});

describe("stored width", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis as Record<string, unknown>, "localStorage");
    vi.restoreAllMocks();
  });

  it("round-trips a width", () => {
    const store = fakeStorage();
    install(store);
    writeStoredWidth("capka.layout.sidebar", 312.4);
    expect(store.map.get("capka.layout.sidebar")).toBe("312");
    expect(readStoredWidth("capka.layout.sidebar", 288)).toBe(312);
  });

  it("uses the fallback when nothing is stored or the value is unusable", () => {
    install(fakeStorage({ a: "not-a-number", b: "0", c: "-40" }));
    expect(readStoredWidth("missing", 288)).toBe(288);
    expect(readStoredWidth("a", 288)).toBe(288);
    expect(readStoredWidth("b", 288)).toBe(288);
    expect(readStoredWidth("c", 288)).toBe(288);
  });

  it("a reset forgets the width rather than storing the default", () => {
    const store = fakeStorage();
    install(store);
    writeStoredWidth("capka.layout.workspace", 400);
    writeStoredWidth("capka.layout.workspace", null);
    expect(store.map.has("capka.layout.workspace")).toBe(false);
    expect(readStoredWidth("capka.layout.workspace", 320)).toBe(320);
  });

  it("survives storage that throws (private window, blocked site data)", () => {
    install({
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
    expect(readStoredWidth("capka.layout.sidebar", 288)).toBe(288);
    expect(() => writeStoredWidth("capka.layout.sidebar", 300)).not.toThrow();
    expect(() => writeStoredWidth("capka.layout.sidebar", null)).not.toThrow();
  });
});
