import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Architectural guards for the image viewer. Its behaviour is tested as
 * arithmetic in `lib/chat/__tests__/image-view`; what's left here can only be
 * checked structurally (this suite has no DOM — `environment: node`), and each
 * guard exists because the property it protects was broken once already.
 */
const VIEWER = readFileSync("src/components/chat/file-preview.tsx", "utf8");

describe("one writer", () => {
  it("nothing but `apply` moves the image", () => {
    // The old version had a zoom path that clamped the scale and a pan path that
    // clamped nothing, so the picture could be dragged clean out of the window.
    // Wheel, pinch, drag, buttons and keys now all end at the same updater,
    // which is the only thing that can enforce the bounds.
    expect(VIEWER.match(/setView\(/g) ?? []).toHaveLength(1);
    expect(VIEWER.match(/applyGesture\(/g) ?? []).toHaveLength(1);
  });
});

describe("the controls are not part of the zoom surface", () => {
  it("no button lives inside the frame", () => {
    // They used to. Every click on them bubbled into the surface's handlers, so
    // double-clicking "+" hit `onDoubleClick` and reset the zoom, and pressing
    // any of them while zoomed started a drag under the cursor.
    const start = VIEWER.indexOf("ref={frame}");
    const picture = VIEWER.indexOf("ref={picture}", start);
    const end = VIEWER.indexOf("</div>", picture);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(picture);
    const surface = VIEWER.slice(start, end);
    expect(surface).not.toMatch(/HeaderButton|<button/);
  });
});

describe("gestures reach us at all", () => {
  it("every gesture listener is registered non-passive, by hand", () => {
    // React registers wheel handlers as PASSIVE, where `preventDefault` is
    // ignored with a console warning and the dialog scrolls behind the zoom. The
    // same is true of Safari's gesture events, which additionally are the only
    // way to stop iOS from zooming the whole page — `touch-action: none` does
    // not, Safari keeps that gesture for accessibility.
    for (const type of ["wheel", "gesturestart", "gesturechange", "gestureend"]) {
      expect(VIEWER).toContain(`addEventListener("${type}", on`);
    }
    expect(VIEWER.match(/passive: false/g) ?? []).toHaveLength(4);
    expect(VIEWER).not.toContain("onWheel=");
  });

  it("macOS Safari is detected by feature, not by user agent", () => {
    // It is the one engine that reports a trackpad pinch as its own GestureEvent
    // rather than as a ctrl-wheel, and the one engine with GestureEvent and no
    // TouchEvent. iOS Safari has both, and there the same events are only
    // suppressed.
    expect(VIEWER).toContain('"GestureEvent" in window && !("TouchEvent" in window)');
  });
});
