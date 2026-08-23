import { describe, it, expect } from "vitest";
import {
  applyGesture,
  maxScale,
  panBounds,
  wheelZoomFactor,
  FLOOR_MAX_SCALE,
  type Geometry,
} from "@/lib/chat/image-view";

/** A 1000x1000 picture fitted exactly into a 1000x1000 pane. */
const fitted: Geometry = { image: { w: 1000, h: 1000 }, frame: { w: 1000, h: 1000 }, naturalWidth: 1000 };
const at = (scale: number, x = 0, y = 0) => ({ scale, x, y });

describe("wheelZoomFactor", () => {
  it("depends on how far the hand moved, not on how many events that took", () => {
    // The bug this replaces read only the SIGN of deltaY, so it measured event
    // frequency: a trackpad emitting four small events zoomed four times as far
    // as a mouse reporting the same distance once.
    const once = wheelZoomFactor({ deltaY: -40 });
    const chunked = [-10, -10, -10, -10].reduce((f, deltaY) => f * wheelZoomFactor({ deltaY }), 1);
    expect(chunked).toBeCloseTo(once, 10);
  });

  it("is exactly reversible", () => {
    // Scrolling back the way you came must return the original scale. A naive
    // x1.15 / x0.87 pair does not: it drifts a little further out every time.
    for (const deltaY of [1, 7, 33, 100]) {
      expect(wheelZoomFactor({ deltaY }) * wheelZoomFactor({ deltaY: -deltaY })).toBeCloseTo(1, 10);
    }
  });

  it("survives a trackpad flick that used to slam into the ceiling", () => {
    // ~40 events of a few pixels each is one unhurried two-finger swipe. Under
    // the old fixed 1.15 step that was 1.15^40 = 267x, i.e. the 8x ceiling in a
    // fraction of a second, and the reason this viewer felt broken.
    const flick = Array.from({ length: 40 }, () => wheelZoomFactor({ deltaY: -4 })).reduce((a, b) => a * b, 1);
    expect(flick).toBeGreaterThan(1.5);
    expect(flick).toBeLessThan(FLOOR_MAX_SCALE / 2);
    expect(1.15 ** 40).toBeGreaterThan(FLOOR_MAX_SCALE);
  });

  it("makes one wheel notch mean the same thing in every browser", () => {
    // Chrome and Safari report ~100 pixels per detent, Firefox reports one line,
    // and a Windows touchpad in page mode reports one page. All three are one
    // notch to the person turning the wheel.
    const chrome = wheelZoomFactor({ deltaY: -100, deltaMode: 0 });
    const firefox = wheelZoomFactor({ deltaY: -1, deltaMode: 1 });
    const pageMode = wheelZoomFactor({ deltaY: -1, deltaMode: 2 });
    expect(firefox).toBeCloseTo(chrome, 10);
    expect(pageMode).toBeCloseTo(chrome, 10);
    expect(chrome).toBeCloseTo(1.25, 2);
  });

  it("leaves a horizontal swipe alone", () => {
    // It used to fall through to the "not negative" branch and zoom OUT, so
    // brushing sideways on a trackpad shrank the picture.
    expect(wheelZoomFactor({ deltaY: 0, deltaX: -300 })).toBe(1);
  });

  it("reads shift-wheel off the axis the browser actually puts it on", () => {
    expect(wheelZoomFactor({ deltaY: 0, deltaX: -100, shiftKey: true })).toBeGreaterThan(1);
  });

  it("treats a ctrl-wheel as the pinch it is, not as a scroll", () => {
    // Browsers deliver a trackpad pinch as a ctrl-wheel with a far smaller delta
    // for the same intent, so the same number must be worth more.
    expect(wheelZoomFactor({ deltaY: -3, ctrlKey: true })).toBeGreaterThan(wheelZoomFactor({ deltaY: -3 }));
  });
});

describe("maxScale", () => {
  it("always lets a large image reach its own pixels", () => {
    // A 10000px screenshot fitted into 900px needs 11x before one of its pixels
    // is shown at its own size; a flat 8x ceiling never gets there.
    const big = { image: { w: 900, h: 600 }, frame: { w: 900, h: 600 }, naturalWidth: 10000 };
    expect(maxScale(big)).toBeCloseTo(10000 / 900);
  });

  it("keeps the generous default for an image that already fits", () => {
    expect(maxScale(fitted)).toBe(FLOOR_MAX_SCALE);
  });

  it("does not divide by an unlaid-out image", () => {
    expect(maxScale({ image: { w: 0, h: 0 }, frame: { w: 900, h: 600 }, naturalWidth: 4000 })).toBe(FLOOR_MAX_SCALE);
  });
});

describe("panBounds", () => {
  it("pins an image that fits to the centre", () => {
    expect(panBounds(fitted, 1)).toEqual({ x: 0, y: 0 });
  });

  it("allows exactly the overflow, split between the two sides", () => {
    expect(panBounds(fitted, 2)).toEqual({ x: 500, y: 500 });
  });
});

describe("applyGesture", () => {
  it("keeps the point under the cursor under the cursor", () => {
    // Anchored, not centred: the thing you aimed at must not slide away while
    // you zoom.
    const before = at(1);
    const cursor = { x: 200, y: -120 };
    const after = applyGesture(before, fitted, 2, cursor, cursor);
    // Where that image point lands on screen: translate + point x scale.
    const imagePoint = { x: cursor.x - before.x, y: cursor.y - before.y };
    expect(after.x + imagePoint.x * after.scale).toBeCloseTo(cursor.x);
    expect(after.y + imagePoint.y * after.scale).toBeCloseTo(cursor.y);
  });

  it("pans by the distance travelled when the scale is unchanged", () => {
    const after = applyGesture(at(2, 0, 0), fitted, 2, { x: 0, y: 0 }, { x: 60, y: -40 });
    expect(after).toEqual({ scale: 2, x: 60, y: -40 });
  });

  it("will not let the image be dragged out of the frame", () => {
    // The whole class of "where did my picture go" — the old pan path clamped
    // nothing at all, so a flick could put the image entirely off screen with
    // only the reset button to get it back.
    const far = applyGesture(at(2, 450, 0), fitted, 2, { x: 0, y: 0 }, { x: 400, y: 0 });
    expect(far.x).toBe(panBounds(fitted, 2).x);
  });

  it("re-centres when the zoom is released", () => {
    expect(applyGesture(at(4, 300, 200), fitted, 1, { x: 90, y: 90 }, { x: 90, y: 90 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });

  it("refuses to go below fit or above the ceiling", () => {
    expect(applyGesture(at(2), fitted, 0.2, { x: 0, y: 0 }, { x: 0, y: 0 }).scale).toBe(1);
    expect(applyGesture(at(2), fitted, 99, { x: 0, y: 0 }, { x: 0, y: 0 }).scale).toBe(FLOOR_MAX_SCALE);
  });

  it("zooms about the midpoint of a pinch and follows it", () => {
    // Two fingers spreading while the hand also drifts: both must happen, and
    // they are one call.
    const after = applyGesture(at(1), fitted, 2, { x: 100, y: 0 }, { x: 140, y: 0 });
    const imagePoint = 100;
    expect(after.x + imagePoint * after.scale).toBeCloseTo(140);
  });
});
