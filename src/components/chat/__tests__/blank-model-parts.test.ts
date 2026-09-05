import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A part the model left blank must not become a row.
 *
 * Reasoning-capable models emit a part carrying nothing but `"\n"` / `"\n\n"`
 * between two tool calls — for their thinking AND for their answer. Such a
 * string is truthy, so a gate written as `if (text)` lets it through, and the
 * block built for it renders as nothing: an empty lightbulb node on the rail, or
 * a rule with a gap under it in the transcript. The text case does further
 * damage than the reasoning one, because a text group SPLITS the rail — one run
 * of work then reads as two spoilers with a hole between them.
 *
 * The rule is one line long: a gate deciding whether a row EXISTS has to ask the
 * same question the renderer will ask. This is asserted over both branches at
 * once because the two were fixed a release apart — reasoning first, text only
 * after a user reported the same gap one part type over.
 */
const MESSAGE = "src/components/chat/message.tsx";

describe("blank model parts never open a row", () => {
  const message = readFileSync(MESSAGE, "utf8");
  // The assistant grouping loop — from the group type through to the last branch.
  const loop = message.slice(message.indexOf("const groups: Group[] = [];"), message.indexOf("const lastTextIdx"));

  it("groups the assistant's parts in one place, so both gates live side by side", () => {
    expect(loop).toContain('if (part.type === "text")');
    expect(loop).toContain('} else if (part.type === "reasoning")');
  });

  it("the text gate asks what will render, not whether the string is truthy", () => {
    const text = loop.slice(loop.indexOf('if (part.type === "text")'), loop.indexOf('} else if (part.type === "reasoning")'));
    expect(text).toMatch(/if \(text\.trim\(\)\) groups\.push/);
    expect(text).not.toMatch(/if \(text\) groups\.push/);
  });

  it("the reasoning gate asks the same question, and only where it OPENS a row", () => {
    const reasoning = loop.slice(loop.indexOf('} else if (part.type === "reasoning")'));
    // A bare "\n\n" appended to a thought already on the rail is a real paragraph
    // break: the continuation branch must keep taking the text as-is.
    expect(reasoning).toMatch(/lastItem\?\.kind === "reasoning"\) \{ lastItem\.text \+= text;/);
    expect(reasoning).toMatch(/if \(!hasVisibleReasoning\(text\)\) continue;/);
  });
});
