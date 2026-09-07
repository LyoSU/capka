import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The chat header's ⋯ runs the same menu as a sidebar row, and one of its items
 * does not survive the move on its own.
 *
 * Rename is an INLINE field: it replaces the whole component's output, so the
 * sidebar row becomes the text box. In the header there is no row — the component
 * renders next to an icon button — so the same branch put a `w-full` input inside
 * an icon-sized span, and Rename read as a menu item that did nothing. Nothing
 * about that is visible to types, and the menu still opened, so only the item
 * itself was broken.
 */

const read = (p: string) => readFileSync(p, "utf8");

describe("the chat header's ⋯ menu", () => {
  it("asks for the dialog rename, because it has no row to turn into a field", () => {
    expect(read("src/components/chat/chat-menu-button.tsx")).toMatch(/renameInDialog/);
  });

  it("the inline field is reached only when it was NOT asked for a dialog", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    // The early return is what swallows the rest of the component's output.
    expect(menu).toMatch(/if \(renaming && !renameInDialog\) \{/);
    // …and the dialog is driven by the same one piece of state, so the two can
    // never both be open or both be missing.
    expect(menu).toMatch(/\{renameInDialog && \(\s*<Dialog open=\{renaming\}/);
  });

  it("both routes into rename commit through the same submit", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    // Two call sites in the dialog (Enter and the Save button) plus the inline
    // form's submit and blur — all of them `submitRename`, never a second copy
    // of the patch.
    expect(menu.split("submitRename").length - 1).toBeGreaterThanOrEqual(4);
    expect(menu.match(/async function submitRename/g)).toHaveLength(1);
  });

  it("deleting the chat you are reading navigates away from it", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    const from = menu.indexOf("async function deleteChat");
    expect(from).toBeGreaterThan(-1);
    expect(menu.slice(from, menu.indexOf("function startRename"))).toMatch(/router\.push\("\/chat"\)/);
  });
});
