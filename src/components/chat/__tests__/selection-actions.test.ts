import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { quotePrompt, fileQuotePrompt, ANSWER_SELECTOR, PREVIEW_TEXT_SELECTOR } from "../selection-actions";

/**
 * A highlighted passage of an answer can be handed to the agent. The prompt shape
 * and the wiring (which text counts as an answer, where the bar is mounted) are
 * invisible to types, so they are pinned here; the pointer behaviour itself needs
 * a browser.
 */
describe("selection actions", () => {
  it("quotes the passage under the instruction as a markdown blockquote, line by line", () => {
    expect(quotePrompt("Explain this:", "First line.\nSecond line.")).toBe("Explain this:\n\n> First line.\n> Second line.");
  });

  it("with no instruction leaves the quote and room to type under it", () => {
    expect(quotePrompt("", "  A passage.  ")).toBe("> A passage.\n\n");
  });

  it("only assistant prose is an answer, and the bar is mounted once in the chat panel", () => {
    const message = readFileSync("src/components/chat/message.tsx", "utf8");
    const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
    const attr = `${ANSWER_SELECTOR.slice(1, -1)}=""`;
    // The attribute sits on the prose wrapper of a reply's text, nowhere else.
    expect(message.split(attr).length - 1).toBe(1);
    // …inside TextContent: no other declaration between that function and the attribute.
    const from = message.indexOf("function TextContent");
    expect(from).toBeGreaterThan(-1);
    expect(message.slice(from + 1, message.indexOf(attr))).not.toMatch(/\nfunction |\nexport /);
    expect(panel.match(/<SelectionActions /g)?.length).toBe(1);
  });

  it("a quote from a FILE names the file above the passage", () => {
    expect(fileQuotePrompt("", "From report.md:", "A finding.")).toBe("From report.md:\n> A finding.\n\n");
    expect(fileQuotePrompt("Explain this part of the file:", "From report.md:", "First.\nSecond.")).toBe(
      "Explain this part of the file:\n\nFrom report.md:\n> First.\n> Second.\n\n",
    );
  });

  it("a file quote always leaves room to type — it is a preamble, not the message", () => {
    for (const instruction of ["", "Explain:"]) {
      expect(fileQuotePrompt(instruction, "From a.txt:", "  Padded.  ")).toMatch(/> Padded\.\n\n$/);
    }
  });

  it("the viewer's bar reads a different mark than the transcript's, so neither steals the other's selection", () => {
    const preview = readFileSync("src/components/chat/file-preview.tsx", "utf8");
    expect(PREVIEW_TEXT_SELECTOR).not.toBe(ANSWER_SELECTOR);
    // The viewer writes the mark; the selector that pairs with it lives here.
    expect(preview.split('data-preview-text=""').length - 1).toBe(2);
  });

  it("the viewer never names the selection namespace — settings opens the same viewer", () => {
    const preview = readFileSync("src/components/chat/file-preview.tsx", "utf8");
    // A component that names a namespace drags its strings into every route that
    // can reach it, and the memory settings page reaches this one. The bar is
    // built by the chat's workspace column and handed down as a node.
    expect(preview).not.toMatch(/useTranslations\("chat\.selection"\)/);
    expect(preview).not.toMatch(/from "\.\/selection-actions"/);
    const panel = readFileSync("src/components/chat/workspace-panel.tsx", "utf8");
    expect(panel).toMatch(/<PreviewSelectionActions /);
  });

  it("is a pointer-device affordance: touch keeps the OS selection menu", () => {
    const src = readFileSync("src/components/chat/selection-actions.tsx", "utf8");
    expect(src).toMatch(/\(pointer: coarse\)/);
  });
});
