import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Clicking a file in the transcript has to bring the files column with it, even
 * when that column is shut.
 *
 * The whole path is optional props and a registration made in an effect, so
 * nothing about it is visible to types: drop the `onOpen` on the panel and the
 * code still compiles, still passes every other test, and a click on a file
 * becomes a click that does nothing — the provider hands the preview to a column
 * that never appears, and skips the dialog because it thinks a host took it. That
 * is the failure this file exists to catch.
 */

const read = (p: string) => readFileSync(p, "utf8");

describe("a file opened from the chat brings the column with it", () => {
  it("the panel is handed a way to open itself, and forwards it to the dock", () => {
    const panel = read("src/components/chat/chat-panel.tsx");
    // The chat panel owns `filesOpen`, so it is the only thing that can open it.
    expect(panel).toMatch(/onOpen=\{\(\) => setFilesOpen\(true\)\}/);
    const workspace = read("src/components/chat/workspace-panel.tsx");
    expect(workspace).toMatch(/usePreviewDock\(onOpen\)/);
  });

  it("a host with no way to appear does not register, so the dialog still shows the file", () => {
    const preview = read("src/components/chat/file-preview.tsx");
    // The gate, and the fact that it is part of the effect's condition.
    expect(preview).toMatch(/const canOpen = !!onRequestOpen;/);
    expect(preview).toMatch(/if \(!register \|\| !canOpen\) return;/);
    expect(preview).toMatch(/\}, \[register, canOpen\]\);/);
  });

  it("opening asks the registered host to appear before handing it the file", () => {
    const preview = read("src/components/chat/file-preview.tsx");
    const from = preview.indexOf("const open = useCallback(");
    expect(from).toBeGreaterThan(-1);
    const body = preview.slice(from, preview.indexOf("}, []);", from));
    // Order matters only in that both happen; the same batch commits them together.
    expect(body).toMatch(/dock\?\.\(\)/);
    expect(body).toMatch(/setState\(\{ files, index:/);
    // On a phone there is nothing to dock beside, so the dialog stays.
    expect(body).toMatch(/isMobileRef\.current \? null : host\.current/);
  });
});
