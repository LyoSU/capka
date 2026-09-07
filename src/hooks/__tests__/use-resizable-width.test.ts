import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { clampWidth, readStoredWidth, shouldCollapse, shouldExpand, writeStoredWidth } from "@/hooks/use-resizable-width";

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

describe("shouldCollapse", () => {
  const MIN = 224; // the sidebar's 14rem

  it("is false anywhere inside the range, and at the minimum itself", () => {
    expect(shouldCollapse(300, MIN)).toBe(false);
    expect(shouldCollapse(MIN, MIN)).toBe(false);
  });

  it("is false for the wobble of a hand that meant to stop at the minimum", () => {
    expect(shouldCollapse(MIN - 1, MIN)).toBe(false);
    expect(shouldCollapse(MIN - 63, MIN)).toBe(false);
  });

  it("is true once the drag is a deliberate shove past it", () => {
    expect(shouldCollapse(MIN - 65, MIN)).toBe(true);
    expect(shouldCollapse(0, MIN)).toBe(true);
    // A pointer dragged past the left edge of the window reports a negative x.
    expect(shouldCollapse(-120, MIN)).toBe(true);
  });
});

describe("shouldExpand", () => {
  it("ignores a nudge, and the wrong direction entirely", () => {
    expect(shouldExpand(0)).toBe(false);
    expect(shouldExpand(40)).toBe(false);
    expect(shouldExpand(-200)).toBe(false);
  });

  it("opens on a deliberate pull", () => {
    expect(shouldExpand(65)).toBe(true);
    expect(shouldExpand(300)).toBe(true);
  });

  it("is the exact inverse of the shove that closed it", () => {
    // Same overshoot both ways: whatever distance shuts a column at its minimum
    // is the distance that brings it back, so the gesture is learnable once.
    const MIN = 224;
    for (const d of [63, 64, 65, 100]) {
      expect(shouldExpand(d)).toBe(shouldCollapse(MIN - d, MIN));
    }
  });
});

describe("the hairline lands ON the border, not beside it", () => {
  it("both nav handles are offset by half a pixel, and that half pixel is load-bearing", () => {
    const nav = readFileSync("src/components/layout/app-sidebar.tsx", "utf8");
    // `border-r` paints the last 1px INSIDE the rail's box, so an 8px strip
    // centred on the edge puts its hairline half a pixel to the right and the two
    // paint 1.5px between them — the fuzzy, doubled line. Measured in a harness:
    // 4px gives border [287,288] against hairline [287.5,288.5]; 4.5px makes them
    // identical. It reads like a typo, which is exactly why it is pinned here.
    expect(nav).toMatch(/calc\(var\(--sidebar-width\) - 4\.5px\)/);
    expect(nav).toMatch(/calc\(var\(--sidebar-width-icon\) - 4\.5px\)/);
    expect(nav).not.toMatch(/calc\(var\(--sidebar-width(-icon)?\) - 4px\)/);
  });
});

describe("both columns take the gesture", () => {
  // Symmetry is the whole point and a silent omission on one side is exactly the
  // regression: one edge would close under a hard drag and the other grind.
  it("the nav and the workspace column each hand the hook a way to close", () => {
    const nav = readFileSync("src/components/layout/app-sidebar.tsx", "utf8");
    const panel = readFileSync("src/components/chat/workspace-panel.tsx", "utf8");
    expect(nav).toMatch(/onCollapse: \(\) => setSidebarOpen\(false\)/);
    expect(panel).toMatch(/onCollapse: onClose/);
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
