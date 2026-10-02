import { describe, it, expect } from "vitest";
import { stripPseudoToolCalls, pseudoToolCallNames, isKnownToolName } from "../pseudo-tool-call";

const strip = (t: string) => stripPseudoToolCalls(t, isKnownToolName);

describe("stripPseudoToolCalls", () => {
  it("drops a textual update_plan call on its own line", () => {
    const t = "Starting.\ncall:default_api:update_plan{steps:[{status:done,title:Gather data},{status:in_progress,title:Report}]}\nDone.";
    expect(strip(t)).toBe("Starting.\nDone.");
  });

  it("drops a call that is the whole text", () => {
    expect(strip("call:default_api:update_plan{steps:[{status:done,title:x}]}")).toBe("");
  });

  it("spans to the MATCHING brace, braces inside strings included", () => {
    const t = 'call:default_api:write_file{path:"a.txt",content:"x } y {"} after';
    expect(strip(t)).toBe("after");
  });

  it("an unclosed payload (still streaming) runs to the end of its line", () => {
    expect(strip("Here is the plan\ncall:default_api:update_plan{steps:[{status:\nNext line")).toBe("Here is the plan\nNext line");
    expect(strip("Here is the plan\ncall:default_api:update_plan{steps:[{sta")).toBe("Here is the plan");
  });

  it("takes along a fence wrapped around nothing but the call", () => {
    expect(strip("Before\n```tool_code\ncall:default_api:update_plan{steps:[]}\n```\nAfter")).toBe("Before\nAfter");
  });

  it("does not eat the fences of neighbouring code blocks", () => {
    const t = "```js\na()\n```\ncall:default_api:update_plan{steps:[]}\n```js\nb()\n```";
    expect(strip(t)).toBe("```js\na()\n```\n```js\nb()\n```");
  });

  it("matches connector tools by prefix", () => {
    expect(strip("call:default_api:mcp__notion__search{query:x}")).toBe("");
  });

  it("leaves a call to a name that is not ours untouched", () => {
    const t = "Example: call:default_api:launch_rockets{now:true}";
    expect(strip(t)).toBe(t);
  });

  it("leaves ordinary prose and code untouched (same string back)", () => {
    for (const t of [
      "I updated the plan and wrote the file report.docx.",
      "Use update_plan{steps} to show progress.",
      "default_api:update_plan{x}",
      "```python\nprint({'a': 1})\n```",
      "  leading and trailing whitespace kept  \n",
    ]) {
      expect(strip(t)).toBe(t);
    }
  });
});

describe("pseudoToolCallNames", () => {
  it("lists our tools called as text, in order, and nothing else", () => {
    const t = "call:default_api:update_plan{a:1}\ncall:default_api:nope{}\ncall:default_api:execute_bash{command:ls}";
    expect(pseudoToolCallNames(t, isKnownToolName)).toEqual(["update_plan", "execute_bash"]);
    expect(pseudoToolCallNames("plain text", isKnownToolName)).toEqual([]);
  });

  it("checks names against the predicate it is given", () => {
    expect(pseudoToolCallNames("call:default_api:custom_tool{}", (n) => n === "custom_tool")).toEqual(["custom_tool"]);
  });
});
