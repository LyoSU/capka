import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The chat header's ⋯ runs the same menu as a sidebar row.
 *
 * Rename used to be an INLINE field that replaced the component's whole output —
 * right on a sidebar row, broken in the header (a `w-full` input inside an
 * icon-sized span). And beside it sat a second item, "Update title", doing the
 * same job by another road. Now there is one Rename, always a dialog, and the
 * suggestion is a button inside it that only FILLS the field.
 */

const read = (p: string) => readFileSync(p, "utf8");

describe("the chat header's ⋯ menu", () => {
  it("has one rename item and no inline field", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    expect(menu.match(/key: "rename"/g)).toHaveLength(1);
    expect(menu).not.toMatch(/regenerate-title/);
    expect(menu).toMatch(/<Dialog open=\{renaming\}/);
    expect(menu).not.toMatch(/onBlur=\{submitRename\}/);
  });

  it("the suggestion fills the field rather than saving", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    expect(menu).toMatch(/\/title\?suggest=1/);
    expect(menu).toMatch(/setRenameValue\(data\.title\)/);
    expect(read("src/app/api/chats/[id]/title/route.ts")).toMatch(/searchParams\.has\("suggest"\)\) return Response\.json/);
  });

  it("every route into rename commits through the same submit", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    // Enter and the Save button — both `submitRename`, never a second copy of
    // the patch.
    expect(menu.split("submitRename").length - 1).toBeGreaterThanOrEqual(3);
    expect(menu.match(/async function submitRename/g)).toHaveLength(1);
  });

  it("deleting the chat you are reading navigates away from it", () => {
    const menu = read("src/components/chat/chat-context-menu.tsx");
    const from = menu.indexOf("async function deleteChat");
    expect(from).toBeGreaterThan(-1);
    expect(menu.slice(from, menu.indexOf("function startRename"))).toMatch(/router\.push\("\/chat"\)/);
  });
});
