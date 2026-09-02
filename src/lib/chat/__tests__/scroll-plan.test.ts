import { describe, it, expect } from "vitest";
import { planScroll, spacerHeight, atRest, endVisible, easeStep, type ScrollSnapshot } from "../scroll-plan";

/**
 * The transcript's scroll decisions, case by case.
 *
 * These replace a suite that grepped `chat-panel.tsx` for the names of helpers —
 * the only kind of test available while the arithmetic was tangled up with
 * `getBoundingClientRect`. Every case below is one row of the real inventory of
 * things that change the transcript's height: a delta streaming in, the reasoning
 * spoiler collapsing, a reader expanding a spoiler, the composer growing, a lazily
 * loaded mermaid diagram re-laying-out history. What matters is not which helper
 * ran but whether the reader's position survived it.
 */

/** An 800px container: 64px reading line, 176px of footer, scrolled to the top. */
function snap(over: Partial<ScrollSnapshot> = {}): ScrollSnapshot {
  return {
    owner: "reader",
    height: 800,
    line: 64,
    reserveNoKb: 176,
    reserveWithKb: 176,
    scrollTop: 0,
    pinTop: null,
    contentEndTop: null,
    contentEndBottom: null,
    spacerH: 0,
    anchorNow: null,
    anchorWas: 0,
    readerActive: false,
    animating: false,
    streaming: false,
    restoring: false,
    wasEndVisible: true,
    ...over,
  };
}

/** Content end exactly at its resting line — the geometry of "at the tail". */
const AT_TAIL = { contentEndBottom: 800 - 176, contentEndTop: 800 - 176 };

describe("spacer", () => {
  it("reserves exactly the room a short reply is missing to lift its question up", () => {
    // Question 500px down, reply ending 120px below it: 800 - 176 - 120 - 64 = 440.
    expect(spacerHeight(snap({ pinTop: 500, contentEndTop: 620 }))).toBe(440);
  });

  it("collapses to zero once the reply fills the screen on its own", () => {
    expect(spacerHeight(snap({ pinTop: 100, contentEndTop: 800 }))).toBe(0);
  });

  it("never rounds up past the overflow boundary", () => {
    // Fractional text heights are the norm. Rounding UP here is what let content
    // rest exactly ON the boundary, flipping the scrollbar on and off with every
    // streamed delta — the bug a hardcoded 2px undershoot used to paper over.
    const exact = 800.6 - 176 - 120.4 - 64;
    const h = spacerHeight(snap({ height: 800.6, pinTop: 500, contentEndTop: 620.4 }));
    expect(h).toBe(440);
    expect(h).toBeLessThanOrEqual(exact);
  });

  it("is not rewritten when it already holds the right value", () => {
    // A no-op write would re-trigger the ResizeObserver that called us.
    expect(planScroll(snap({ owner: "pin", pinTop: 500, contentEndTop: 620, spacerH: 440 })).spacerH).toBeNull();
  });

  it("is kept correct even when nothing may be written", () => {
    // Mid-gesture the position is the reader's, but the spacer changes no visible
    // position — and having it right is what makes the resumed pin land without a
    // second jump.
    const p = planScroll(snap({ owner: "pin", readerActive: true, pinTop: 500, contentEndTop: 620 }));
    expect(p.target).toBeNull();
    expect(p.spacerH).toBe(440);
  });
});

describe("at the tail vs the end being visible", () => {
  it("distinguishes resting at the tail from merely seeing the end", () => {
    // A short pinned reply has its end plainly on screen while sitting nowhere near
    // the rest line. Conflating the two would let following resume and drag it up.
    const shortReply = snap({ contentEndBottom: 200 });
    expect(endVisible(shortReply)).toBe(true);
    expect(atRest(shortReply)).toBe(false);
  });

  it("counts as at rest within a rounding allowance", () => {
    expect(atRest(snap({ contentEndBottom: 624 }))).toBe(true);
    expect(atRest(snap({ contentEndBottom: 627 }))).toBe(true);
    expect(atRest(snap({ contentEndBottom: 640 }))).toBe(false);
  });

  it("resting at the tail always implies seeing the end", () => {
    // The two thresholds measure the same geometry, so one cannot be stricter than
    // the other. A tighter entry threshold meant the two-pixel residue that `tail`
    // legitimately leaves could never re-enter the state, and the jump pill stayed
    // on screen offering to take the reader where they already were.
    for (const o of [-500, -4, -1, 0, 1, 2, 3, 4]) {
      const s = snap({ contentEndBottom: 624 + o, wasEndVisible: false });
      if (atRest(s)) expect(endVisible(s)).toBe(true);
    }
  });

  it("needs travel to stop reporting the end as visible", () => {
    // Hysteresis: without the gap the jump pill flickers as a reply streams across
    // the boundary.
    expect(endVisible(snap({ contentEndBottom: 650, wasEndVisible: true }))).toBe(true);
    expect(endVisible(snap({ contentEndBottom: 650, wasEndVisible: false }))).toBe(false);
    expect(endVisible(snap({ contentEndBottom: 700, wasEndVisible: true }))).toBe(false);
  });

  it("takes the keyboard into account", () => {
    // The visible bottom is the footer PLUS the keyboard, so content sitting behind
    // the keys is not "the end being visible".
    const keysUp = { reserveWithKb: 476, contentEndBottom: 620, wasEndVisible: false };
    expect(endVisible(snap(keysUp))).toBe(false);
    expect(endVisible(snap({ ...keysUp, reserveWithKb: 176 }))).toBe(true);
  });
});

describe("pin", () => {
  it("holds the newest question on the reading line as the reply grows", () => {
    const p = planScroll(snap({ owner: "pin", scrollTop: 200, pinTop: 300, contentEndTop: 420, contentEndBottom: 420 }));
    expect(p.owner).toBe("pin");
    expect(p.target).toBe(436); // 200 + 300 - 64
    expect(p.motion).toBe("instant");
  });

  it("hands off to following the tail the moment the spacer reaches zero", () => {
    const p = planScroll(snap({
      owner: "pin", streaming: true, scrollTop: 500, pinTop: 64, contentEndTop: 900, contentEndBottom: 900, spacerH: 0,
    }));
    expect(p.owner).toBe("tail");
  });

  it("does not hand off while the question is still displaced", () => {
    // Spacer is zero, but the question is 200px off the line — something just
    // changed height and the pin owes it a correction first. Handing off here is
    // what would turn a correction into a jump.
    const p = planScroll(snap({
      owner: "pin", streaming: true, scrollTop: 500, pinTop: 264, contentEndTop: 900, contentEndBottom: 900, spacerH: 0,
    }));
    expect(p.owner).toBe("pin");
    expect(p.target).toBe(700);
  });
});

describe("tail", () => {
  it("rests the write head just above the footer, not at the very edge", () => {
    const p = planScroll(snap({ owner: "tail", streaming: true, scrollTop: 1000, contentEndBottom: 900 }));
    expect(p.target).toBe(1276); // 1000 + 900 - (800 - 176)
  });

  it("snaps a token-sized delta and eases a whole block landing", () => {
    // Following a write head is a stream of tiny moves; easing those would smear
    // text that should simply appear. A table or an image resolving at once is a
    // third of a screen, and snapping that reads as the page being yanked.
    const small = planScroll(snap({ owner: "tail", streaming: true, contentEndBottom: 624 + 20 }));
    const big = planScroll(snap({ owner: "tail", streaming: true, contentEndBottom: 624 + 300 }));
    expect(small.motion).toBe("instant");
    expect(big.motion).toBe("ease");
  });

  it("stands down when no turn is streaming", () => {
    // "Follow the write head" is meaningless with nothing writing. Leaving it armed
    // while idle is what turned every late image and lazy syntax-highlight pass into
    // a yank to the bottom.
    const p = planScroll(snap({ owner: "tail", streaming: false, contentEndBottom: 900, anchorNow: 100, anchorWas: 100 }));
    expect(p.owner).toBe("reader");
    expect(p.target).toBeNull();
  });

  it("resumes on its own when a turn starts while the reader rests at the end", () => {
    const p = planScroll(snap({ owner: "reader", streaming: true, ...AT_TAIL }));
    expect(p.owner).toBe("tail");
  });

  it("a tall batch landing under `tail` never reports the end as out of view", () => {
    // The jump pill flickered while a reply streamed: a batch taller than the exit
    // hysteresis (a whole paragraph) pushed the content end past the boundary in
    // the geometry read BEFORE the correction, the pill showed, the same pass then
    // scrolled to the end and the next pass hid it. Following the write head means
    // the end WILL be on screen once this pass writes — report that.
    const p = planScroll(snap({ owner: "tail", streaming: true, wasEndVisible: true, contentEndBottom: 624 + 120 }));
    expect(p.target).not.toBeNull();
    expect(p.endVisible).toBe(true);
  });

  it("…but a reader driving under `tail` still sees the honest geometry", () => {
    // Nothing is written while a finger is on the glass, so nothing will bring the
    // end back on screen this pass; the pill must tell the truth then.
    const p = planScroll(snap({ owner: "tail", streaming: true, readerActive: true, wasEndVisible: true, contentEndBottom: 624 + 120 }));
    expect(p.target).toBeNull();
    expect(p.endVisible).toBe(false);
  });

  it("does NOT resume merely because the end is visible", () => {
    // The end of a short pinned reply is on screen but far from the rest line.
    const p = planScroll(snap({ owner: "reader", streaming: true, contentEndBottom: 200, anchorNow: 50, anchorWas: 50 }));
    expect(p.owner).toBe("reader");
    expect(p.target).toBeNull();
  });
});

describe("reader — holding their place", () => {
  it("compensates a height change ABOVE them", () => {
    // The reasoning spoiler collapsed by 2000px above: the row they were reading was
    // 100px down and is now 1900px higher.
    expect(planScroll(snap({ scrollTop: 3000, anchorWas: 100, anchorNow: -1900 })).target).toBe(1000);
  });

  it("ignores a height change BELOW them", () => {
    expect(planScroll(snap({ scrollTop: 3000, anchorWas: 100, anchorNow: 100 })).target).toBeNull();
  });

  it("ignores sub-pixel drift", () => {
    expect(planScroll(snap({ scrollTop: 3000, anchorWas: 100, anchorNow: 100.4 })).target).toBeNull();
  });

  it("writes nothing while the reader is driving", () => {
    expect(planScroll(snap({ readerActive: true, scrollTop: 3000, anchorWas: 100, anchorNow: -1900 })).target).toBeNull();
  });

  it("writes nothing while one of our own eased scrolls owns the position", () => {
    expect(planScroll(snap({ animating: true, scrollTop: 3000, anchorWas: 100, anchorNow: -1900 })).target).toBeNull();
  });

  it("has nothing to hold on an empty transcript", () => {
    expect(planScroll(snap()).target).toBeNull();
  });
});

describe("interaction — the reader pressed a disclosure", () => {
  it("holds the pressed row still while its panel grows", () => {
    // The panel added height below the trigger, so the trigger itself has not moved:
    // nothing to correct, and nothing that may move the view.
    const p = planScroll(snap({ owner: "interaction", streaming: true, scrollTop: 500, contentEndBottom: 2000, anchorWas: 300, anchorNow: 300 }));
    expect(p.target).toBeNull();
  });

  it("outranks following the tail — THE reported bug", () => {
    // Scrolled to the very end, a turn streaming, and the reader opens a spoiler.
    // Without ownership, `tail` saw the added height as more reply to chase and
    // pinned the transcript to the bottom, shooting the pressed row off the top.
    const geometry = { streaming: true, scrollTop: 500, contentEndBottom: 1400, anchorWas: 300, anchorNow: 300 };
    expect(planScroll(snap({ owner: "tail", ...geometry })).target).toBe(1276);
    expect(planScroll(snap({ owner: "interaction", ...geometry })).target).toBeNull();
  });

  it("outranks a pinned question too", () => {
    // Expanding a spoiler in an OLDER turn used to yank the newest question back to
    // the reading line, which is the same bug pointing the other way.
    const geometry = { scrollTop: 500, pinTop: 900, contentEndTop: 1000, contentEndBottom: 1000, anchorWas: 300, anchorNow: 300 };
    expect(planScroll(snap({ owner: "pin", ...geometry })).target).toBe(1336);
    expect(planScroll(snap({ owner: "interaction", ...geometry })).target).toBeNull();
  });

  it("still corrects when the panel grew ABOVE the pressed row", () => {
    // Collapsing a panel further up moves the trigger; holding it means following it.
    expect(planScroll(snap({ owner: "interaction", scrollTop: 900, anchorWas: 400, anchorNow: 150 })).target).toBe(650);
  });

  it("never resumes following by itself", () => {
    // Even resting exactly at the end with a turn streaming: ownership was taken
    // deliberately and only expiry or the reader gives it back.
    const p = planScroll(snap({ owner: "interaction", streaming: true, ...AT_TAIL, anchorWas: 0, anchorNow: 0 }));
    expect(p.owner).toBe("interaction");
    expect(p.target).toBeNull();
  });
});

describe("restoring — a chat opened with history", () => {
  it("keeps re-landing at the end while the layout is still moving", () => {
    // Images decoding and the shiki/mermaid chunk landing all grow content ABOVE the
    // landing point. Holding the reading line — correct at any other time — would
    // faithfully hold a position that is no longer the end, and a long chat would
    // open to somewhere in its middle.
    const p = planScroll(snap({ owner: "tail", streaming: false, restoring: true, scrollTop: 100, contentEndBottom: 1400 }));
    expect(p.owner).toBe("tail");
    expect(p.target).toBe(876);
  });

  it("stands down once the window closes", () => {
    const p = planScroll(snap({ owner: "tail", streaming: false, restoring: false, scrollTop: 100, contentEndBottom: 1400, anchorNow: 10, anchorWas: 10 }));
    expect(p.owner).toBe("reader");
    expect(p.target).toBeNull();
  });

  it("yields to the reader immediately", () => {
    expect(planScroll(snap({ owner: "tail", restoring: true, readerActive: true, contentEndBottom: 1400 })).target).toBeNull();
  });
});

describe("invariants", () => {
  const geometries: Partial<ScrollSnapshot>[] = [
    { scrollTop: 0, contentEndBottom: 300, anchorNow: 10, anchorWas: 10 },
    { scrollTop: 1200, contentEndBottom: 900, anchorNow: 90, anchorWas: 400, pinTop: 120, contentEndTop: 800 },
    { scrollTop: 50, contentEndBottom: 5000, anchorNow: -300, anchorWas: 64, pinTop: -200, contentEndTop: 4000 },
    { scrollTop: 900, ...AT_TAIL, anchorNow: 64, anchorWas: 64 },
  ];
  const owners = ["reader", "interaction", "pin", "tail"] as const;

  it("a reader driving the scroller is never written over, in any owner", () => {
    for (const owner of owners) {
      for (const g of geometries) {
        for (const streaming of [true, false]) {
          expect(planScroll(snap({ ...g, owner, streaming, readerActive: true })).target).toBeNull();
        }
      }
    }
  });

  it("a disclosure press never turns into bottom-following", () => {
    for (const g of geometries) {
      for (const streaming of [true, false]) {
        expect(planScroll(snap({ ...g, owner: "interaction", streaming })).owner).toBe("interaction");
      }
    }
  });

  it("an unmoved anchor never produces a write outside a driven owner", () => {
    for (const g of geometries) {
      const held = { ...g, anchorNow: 123, anchorWas: 123 };
      expect(planScroll(snap({ ...held, owner: "reader" })).target).toBeNull();
      expect(planScroll(snap({ ...held, owner: "interaction" })).target).toBeNull();
    }
  });

  it("a correction always lands the anchor back on its captured offset", () => {
    for (const owner of ["reader", "interaction"] as const) {
      for (const drift of [-2000, -37, 5, 512]) {
        const s = snap({ owner, scrollTop: 3000, anchorWas: 200, anchorNow: 200 + drift });
        const p = planScroll(s);
        // Scrolling by `target - scrollTop` moves content the other way by the same
        // amount, so the anchor's screen position returns to where it was captured.
        expect(s.anchorNow! - (p.target! - s.scrollTop)).toBeCloseTo(s.anchorWas, 6);
      }
    }
  });

  it("never reports a motion without a target, or a target without a motion", () => {
    for (const owner of owners) {
      for (const g of geometries) {
        for (const readerActive of [true, false]) {
          const p = planScroll(snap({ ...g, owner, readerActive, streaming: true }));
          expect(p.target == null).toBe(p.motion === "none");
        }
      }
    }
  });
});

describe("easing", () => {
  it("never overshoots, at any frame rate", () => {
    for (const dt of [4, 16, 33, 64]) {
      const step = easeStep(500, dt, 70);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(500);
    }
  });

  it("covers the same ground per unit time regardless of frame rate", () => {
    // One 32ms frame must land where two 16ms frames do, or a 120Hz phone and a
    // 60Hz laptop would follow the tail at visibly different speeds.
    const oneBigFrame = easeStep(500, 32, 70);
    let left = 500;
    left -= easeStep(left, 16, 70);
    left -= easeStep(left, 16, 70);
    expect(500 - left).toBeCloseTo(oneBigFrame, 6);
  });

  it("preserves the sign when catching up from below", () => {
    expect(easeStep(-500, 16, 70)).toBeLessThan(0);
  });
});
