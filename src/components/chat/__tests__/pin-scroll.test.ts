import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Architectural guards for the transcript's scrolling — the three decisions that
 * are invisible in a diff and expensive to rediscover.
 *
 * The behaviour itself is tested as arithmetic in `lib/chat/__tests__/scroll-plan`.
 * What's left here can only be checked structurally (this suite has no DOM —
 * `environment: node`), and each guard exists because the property it protects was
 * broken once already.
 */
const HOOK = "src/components/chat/use-chat-scroll.ts";
const PANEL = "src/components/chat/chat-panel.tsx";
const TRANSCRIPT = [
  PANEL,
  "src/components/chat/message.tsx",
  "src/components/chat/chat-nav.tsx",
  // Opening an editor changes the transcript's height and sits inside it, which
  // is exactly the shape of the four writers this guard was put up against.
  "src/components/chat/message-editor.tsx",
];

describe("one writer", () => {
  it("nothing but the scroll engine moves the transcript", () => {
    // The old implementation had four places nudging `scrollTop` by their own
    // delta — the pin re-seat, the composer-resize shift, the keyboard shift and
    // a native smooth scroll — and they disagreed with each other. Every one of
    // them now goes through the engine, which is also the only thing that can
    // remember what it wrote (see the next guard).
    for (const file of TRANSCRIPT) {
      expect(readFileSync(file, "utf8")).not.toMatch(/scrollTop\s*[+-]?=|scrollTo\(|scrollIntoView\(/);
    }
  });

  it("the engine itself assigns scrollTop in exactly one function", () => {
    const src = readFileSync(HOOK, "utf8");
    expect(src.match(/\.scrollTop\s*[+-]?=/g) ?? []).toHaveLength(1);
    // …and that assignment records what it wrote. Reader input is detected purely
    // by comparing the live position against this value, so an assignment that
    // skipped the bookkeeping would read as the reader grabbing the scroller and
    // silently drop us out of following the tail.
    const write = src.slice(src.indexOf("const write = useCallback("));
    expect(write.slice(0, write.indexOf("}, []);"))).toContain("s.current.written = el.scrollTop");
  });
});

describe("the reader outranks everything", () => {
  it("the keyboard lift is gated on the reader not driving", () => {
    // The one invariant this engine has is that nothing writes while the reader is
    // driving — and the keyboard is the path that broke it: manual scrolling sets
    // `owner = "reader"`, so a check on ownership ALONE let an inset change land
    // mid-touch. iOS can raise or dismiss the keyboard during a gesture, so the
    // delta has to be banked and flushed when control comes back.
    const src = readFileSync(HOOK, "utf8");
    const fn = src.slice(src.indexOf("const applyKeyboardShift = useCallback("));
    const body = fn.slice(0, fn.indexOf("}, ["));
    expect(body).toContain("st.readerActive");
    // Banked, not dropped: measured and applied are tracked separately so the lift
    // is still owed after the gesture rather than silently lost.
    expect(body).toContain("st.kbInset - st.kbApplied");
    // …and something has to pay that debt when the gesture ends.
    const end = src.slice(src.indexOf("const endReaderControl = useCallback("));
    expect(end.slice(0, end.indexOf("}, ["))).toContain("applyKeyboardShift()");
  });

  it("a finger on the glass counts as the reader driving", () => {
    // `touchActive` gating only the idle timer was half a fix: writes are suppressed
    // by `readerActive`, which is set from actual scrolling — so a reader holding
    // still mid-read still had streamed deltas written under their thumb.
    const src = readFileSync(HOOK, "utf8");
    const snap = src.slice(src.indexOf("readerActive: s.current."));
    expect(snap.slice(0, snap.indexOf("\n"))).toContain("s.current.touchActive");
  });

  it("every write we make re-anchors, so we never undo our own motion", () => {
    // Movement the engine performs on purpose is a new reading position. Without
    // this, the settle after an explicit jump measured that jump as drift and
    // scrolled straight back — the jump pill appeared to do nothing at all.
    const src = readFileSync(HOOK, "utf8");
    const write = src.slice(src.indexOf("const write = useCallback("));
    expect(write.slice(0, write.indexOf("}, ["))).toContain("captureAnchor()");
  });

  it("resuming the drive is decided from fresh geometry, not a cached flag", () => {
    // `scrollend` can arrive before the frame that refreshes the cache, so deciding
    // here judged a reader who had just scrolled away against where they had been —
    // and dragged them back to the end they had left. `planScroll` owns that rule.
    const src = readFileSync(HOOK, "utf8");
    const fn = src.slice(src.indexOf("const endReaderControl = useCallback("));
    const body = fn.slice(0, fn.indexOf("}, ["));
    expect(body).not.toContain('setOwner("tail"');
    expect(body).toContain("settle()");
  });

  it("viewport bursts collapse into one frame", () => {
    // iOS fires resize and scroll on the visual viewport repeatedly through a
    // keyboard animation. A frame request per event meant several complete
    // measure-and-settle passes inside a single frame.
    const src = readFileSync(HOOK, "utf8");
    const fn = src.slice(src.indexOf("const onViewportChange = useCallback("));
    expect(fn.slice(0, fn.indexOf("}, ["))).toContain("if (s.current.vvRaf) return;");
  });
});

describe("no unpainted frame", () => {
  it("height changes settle inside the ResizeObserver, not on the next frame", () => {
    // ResizeObserver callbacks run after layout and before paint, so a correction
    // made there lands in the same frame as the change that caused it. Deferring
    // to requestAnimationFrame would paint one uncompensated frame — and one frame
    // of a reasoning block collapsing by 2000px is plainly visible.
    const src = readFileSync(HOOK, "utf8");
    const ro = src.slice(src.indexOf("const ro = new ResizeObserver("));
    expect(ro.slice(0, ro.indexOf("\n"))).toContain("settle()");
  });
});

describe("the navigator's active turn", () => {
  it("the end of the transcript wins over the reading line", () => {
    // Several turns fit on one screen, so the block on the reading line usually
    // belongs to a turn two or three back. At the very bottom that read as the
    // wrong mark being lit while the reader looked straight at the newest reply —
    // and it made the LAST mark unreachable by scrolling at all.
    const src = readFileSync(HOOK, "utf8");
    expect(src).toContain("const upTo = st.endVisible || !anchor ? nodes.length - 1 : nodes.indexOf(anchor)");
  });

  it("crossing into view re-derives it, since no intersection reports that", () => {
    // The last pixels of a scroll to the bottom move nothing in or out of the
    // observed region, so the observer stays silent and the highlight would sit on
    // whatever the reading line said before. `settle` owns that boundary.
    const src = readFileSync(HOOK, "utf8");
    const branch = src.slice(src.indexOf("if (plan.endVisible !== s.current.endVisible) {"));
    expect(branch.slice(0, branch.indexOf("\n    }"))).toContain("s.current.recomputeActive?.()");
    // Lent out by the observer effect and taken back on teardown — a call into a
    // disconnected observer's node set would highlight from a stale `seen`.
    expect(src).toContain("st.recomputeActive = recompute");
    expect(src).toContain("st.recomputeActive = null");
  });
});

describe("cross-platform anchoring", () => {
  it("the container opts out of native scroll anchoring", () => {
    // Safari ships `overflow-anchor` in no stable release, so the engine
    // compensates height changes above the reader itself. Leaving the native one
    // on means Chrome and Firefox ALSO compensate, on top of us — which is how the
    // end of a turn came to feel calm on Android and jumpy on an iPhone.
    expect(readFileSync(PANEL, "utf8")).toContain("[overflow-anchor:none]");
  });
});
