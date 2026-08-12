import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Invariants the phone depends on and a desktop browser never shows.
 *
 * Heights are `dvh`: mobile Safari's `vh` ignores browser chrome, so a `vh` overlay
 * extends past the bottom of the screen with nothing to scroll. And every dashboard
 * page owns its scrolling — the shell (`SidebarInset`) is `overflow-hidden` and the
 * document never scrolls, so a page without a scroller isn't "a bit tall": whatever
 * is past the fold is unreachable, which is how /projects shipped.
 */
const SRC = "src";
const DASHBOARD = "src/app/(dashboard)";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx|css)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("mobile viewport", () => {
  it("sizes heights in dvh, not vh", () => {
    const offenders = walk(SRC)
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => /\bh-screen\b|\bh-\[\d+vh\]|\bmax-h-\[\d+vh\]|\bmin-h-\[\d+vh\]|height:\s*\d+vh/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("gives every dashboard page a scroller, or delegates to a layout that has one", () => {
    // A page under a route group whose layout scrolls (settings) is covered by it;
    // the chat routes hand the whole pane to ChatPanel, which scrolls internally.
    const covered = /\/settings\/|\/chat\//;
    const pages = walk(DASHBOARD).filter((f) => /\/page\.tsx$/.test(f) && !covered.test(f));
    const unscrollable = pages.filter((f) => {
      const src = readFileSync(f, "utf8");
      // Either the page scrolls itself, or it hands the pane to a component that
      // does. Named exactly — matching `<Project` would have counted the modal
      // `<ProjectDialog>` a /projects page renders alongside its (unscrollable)
      // list, which is how this assertion first passed against the bug.
      return !/overflow-y-auto|overflow-auto/.test(src) && !/<ProjectHub\b|<ChatPanel\b/.test(src);
    });
    expect(unscrollable).toEqual([]);
  });

  it("lets the top banner's message wrap instead of shrinking to its longest word", () => {
    // The action link is shrink-0, so on a narrow screen the message was the only
    // item that could give — and a flex item bottoms out at its min-content, i.e.
    // one word per line.
    const banner = readFileSync("src/components/layout/top-banner.tsx", "utf8");
    const row = banner.slice(banner.indexOf('role="status"'));
    expect(row.slice(0, row.indexOf(">"))).toMatch(/\bflex-wrap\b/);
  });
});
