import { describe, it, expect } from "vitest";
import { withHardBreaks } from "@/lib/chat/user-markdown";

describe("withHardBreaks", () => {
  it("turns a single newline into a hard break", () => {
    expect(withHardBreaks("one\ntwo")).toBe("one  \ntwo");
  });

  it("leaves paragraph breaks alone", () => {
    expect(withHardBreaks("one\n\ntwo")).toBe("one\n\ntwo");
  });

  it("does not touch the inside of a code fence", () => {
    const src = "look:\n```js\nconst a = 1;\nconst b = 2;\n```\nafter\nlast";
    expect(withHardBreaks(src)).toBe("look:\n```js\nconst a = 1;\nconst b = 2;\n```\nafter  \nlast");
  });

  it("keeps an unclosed fence verbatim to its end", () => {
    const src = "start\n```\na\nb";
    expect(withHardBreaks(src)).toBe("start\n```\na\nb");
  });

  it("keeps list items as items", () => {
    expect(withHardBreaks("- a\n- b")).toBe("- a  \n- b");
  });

  // The renderer accepts ~~~ fences too, so a message that uses them must come out
  // of the transform byte-identical inside the block — otherwise the rendered and
  // copied code carry two trailing spaces the person never typed.
  it("does not touch the inside of a tilde fence", () => {
    expect(withHardBreaks("~~~\na\nb\n~~~")).toBe("~~~\na\nb\n~~~");
  });

  it("keeps an unclosed tilde fence verbatim to its end", () => {
    expect(withHardBreaks("start\n~~~\na\nb")).toBe("start\n~~~\na\nb");
  });

  it("resumes hard breaks after a closed tilde fence", () => {
    expect(withHardBreaks("~~~\na\n~~~\nafter\nlast")).toBe("~~~\na\n~~~\nafter  \nlast");
  });

  it("does not let the other marker close a fence", () => {
    expect(withHardBreaks("~~~\na\n```\nb\n~~~")).toBe("~~~\na\n```\nb\n~~~");
  });

  it("needs a closing fence at least as long as the opening one", () => {
    // ``` cannot close ````` (CommonMark), so those lines are still code.
    expect(withHardBreaks("`````\na\n```\nb\n`````")).toBe("`````\na\n```\nb\n`````");
  });

  it("accepts a longer closing fence", () => {
    expect(withHardBreaks("~~~\na\n~~~~~\nafter\nlast")).toBe("~~~\na\n~~~~~\nafter  \nlast");
  });

  it("does not open a block on inline code that starts with three backticks", () => {
    expect(withHardBreaks("```a``b``\nnext")).toBe("```a``b``  \nnext");
  });

  // CommonMark lets only spaces and tabs follow a closing fence, but `.trim()` also
  // strips Unicode spaces — so a no-break space closed the block for us while the
  // renderer kept it open, and the code after it grew trailing spaces.
  it("does not let a no-break space close a fence", () => {
    const src = "~~~\na\n~~~\u00A0\nb\nc";
    expect(withHardBreaks(src)).toBe(src);
  });

  it("still closes a fence trailed by spaces and tabs", () => {
    expect(withHardBreaks("~~~\na\n~~~ \t\nafter\nlast")).toBe("~~~\na\n~~~ \t\nafter  \nlast");
  });
});
