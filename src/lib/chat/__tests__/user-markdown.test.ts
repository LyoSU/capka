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
});
