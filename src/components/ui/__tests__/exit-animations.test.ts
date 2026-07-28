import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * base-ui keeps a popup — and, for dialogs, its backdrop — mounted until the
 * exit animation reports finished, while tw-animate-css leaves
 * `animation-fill-mode` at `none`. So the frame an `animate-out` ends, the
 * element snaps back to its base style for as long as it stays mounted: on a
 * dialog, whose backdrop fades in 150ms but whose popup takes 200ms, the
 * dimming visibly blinks back on before it disappears.
 *
 * `fill-mode-forwards` is the fix, and forgetting it is invisible to types and
 * lint — it was fixed once in dialog.tsx and stayed broken in alert-dialog.tsx
 * for exactly that reason. Checked here instead.
 */
const UI_DIR = "src/components/ui";

describe("exit animations", () => {
  it("hold their last frame until base-ui unmounts the element", () => {
    const missing: string[] = [];
    for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(`${UI_DIR}/${file}`, "utf8");
      for (const [, classes] of src.matchAll(/"([^"]*\banimate-out\b[^"]*)"/g)) {
        if (!/\bfill-mode-/.test(classes)) missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});
