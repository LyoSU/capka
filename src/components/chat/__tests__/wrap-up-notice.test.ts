import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { ChatMessage } from "../message";
import { toUIMessages } from "@/lib/chat/presenter";
import en from "../../../../messages/en.json";
import uk from "../../../../messages/uk.json";

/**
 * A completed reply written with its tools withdrawn (out of steps, time or tool
 * output) used to look exactly like a finished one. It now carries the part-way
 * notice and Continue a cut-off turn gets — through the presenter, so it survives a
 * reload — with the limit that fired kept to the admin-only details.
 */
const render = (opts: { isAdmin?: boolean; locale?: "en" | "uk"; wrapUp?: "steps" | "time" | "output" }) => {
  const [message] = toUIMessages([{
    id: "m1", role: "assistant", content: "Half is done.", createdAt: null, platform: null,
    metadata: { status: "completed", parts: [{ type: "text", text: "Half is done." }], ...(opts.wrapUp ? { wrapUp: opts.wrapUp } : {}) },
  }]);
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale: opts.locale ?? "en", messages: opts.locale === "uk" ? uk : en,
    children: createElement(ChatMessage, { message, isAdmin: opts.isAdmin, onContinue: () => {} } as never),
  }));
};
// The markup escapes an apostrophe.
const escaped = (s: string) => s.replace(/'/g, "&#x27;");

describe("wrap-up notice", () => {
  it("offers Continue under a reply that wrapped up, calmly, without the red failure badge", () => {
    const html = render({ wrapUp: "steps" });
    expect(html).toContain(escaped(en.chat.message.wrapUp));
    expect(html).toContain(en.chat.tool.continueTurn);
    expect(html).not.toContain("bg-destructive");
    // The limit is machinery: not in front of a regular user.
    expect(html).not.toContain("FORCE_TEXT_AFTER_STEPS");
  });

  it("shows an admin which limit fired, behind the technical details", () => {
    expect(render({ wrapUp: "time", isAdmin: true })).toContain(en.chat.tool.technicalDetails);
  });

  it("is in Ukrainian for a Ukrainian reader", () => {
    expect(render({ wrapUp: "output", locale: "uk" })).toContain(uk.chat.message.wrapUp);
  });

  it("says nothing under an ordinary finished reply", () => {
    const html = render({});
    expect(html).not.toContain(escaped(en.chat.message.wrapUp));
    expect(html).not.toContain(en.chat.tool.continueTurn);
  });
});

describe("raw reasoning text", () => {
  const html = (isAdmin: boolean) => {
    const [message] = toUIMessages([{
      id: "m2", role: "assistant", content: "Done.", createdAt: null, platform: null,
      metadata: { status: "completed", parts: [
        { type: "reasoning", text: "The user is asking me to convert the file" },
        { type: "tool-call", id: "t1", name: "bash", input: { command: "ls" } },
        { type: "tool-result", id: "t1", output: "ok" },
        { type: "text", text: "Done." },
      ] },
    }]);
    // eslint-disable-next-line react/no-children-prop
    return renderToStaticMarkup(createElement(NextIntlClientProvider, {
      locale: "en", messages: en,
      children: createElement(ChatMessage, { message, isAdmin } as never),
    }));
  };
  it("is not rendered for a regular user, who still gets the answer", () => {
    const out = html(false);
    expect(out).not.toContain("The user is asking me");
    expect(out).toContain("Done.");
  });
  // The spoiler is collapsed in static markup, so the admin's reasoning shows up as
  // the header label ("Reasoning"); a regular user's run is a plain activity run.
  it("is still on the admin's rail", () => {
    expect(html(true)).toContain(`>${en.chat.message.reasoning}<`);
    expect(html(false)).not.toContain(`>${en.chat.message.reasoning}<`);
  });
});
