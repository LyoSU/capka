import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Two invariants the phone depends on, both invisible on a desktop browser.
 *
 * 1. Heights are `dvh`, never `vh` / `h-screen`. Mobile Safari's `vh` measures the
 *    viewport as if the browser chrome weren't there, so a 100vh overlay runs off
 *    the bottom of the screen and an 85vh one hides its own footer behind the
 *    toolbar — with nothing to scroll, since the overlay is exactly as tall as it
 *    thinks the screen is. `dvh` tracks the real, visible viewport.
 *
 * 2. Every dashboard page owns its scrolling. The shell (`SidebarInset`) is
 *    `overflow-hidden` and the document itself never scrolls, so a page with no
 *    scroller of its own is not "a bit tall" — everything past the fold is
 *    unreachable. /projects shipped that way: on a phone the header plus three rows
 *    filled the screen and the rest of the list could not be reached at all.
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
