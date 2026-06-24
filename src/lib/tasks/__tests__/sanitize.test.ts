import { describe, it, expect } from "vitest";
import { stripNul } from "../sanitize";

const NUL = "\u0000";

describe("stripNul", () => {
  it("removes NUL from a plain string", () => {
    expect(stripNul(`a${NUL}b${NUL}`)).toBe("ab");
  });

  it("reaches NUL nested in objects and arrays (the real tool-result shape)", () => {
    const output = { content: [{ type: "image", data: `${NUL}PNG${NUL}\r\n` }], error: null };
    expect(stripNul(output)).toEqual({
      content: [{ type: "image", data: "PNG\r\n" }],
      error: null,
    });
  });

  it("guarantees no NUL survives anywhere — so the jsonb/NOTIFY write can't throw", () => {
    const dirty = { a: `x${NUL}`, b: [`${NUL}`, { c: `${NUL}y${NUL}` }] };
    expect(JSON.stringify(stripNul(dirty)).includes(NUL)).toBe(false);
  });

  it("leaves clean values and non-string types untouched", () => {
    expect(stripNul("clean text")).toBe("clean text");
    expect(stripNul({ n: 1, ok: true, nil: null, arr: [1, 2] })).toEqual({
      n: 1, ok: true, nil: null, arr: [1, 2],
    });
  });

  it("preserves other control characters — only NUL is illegal in jsonb", () => {
    expect(stripNul("tab\tnewline\nsub")).toBe("tab\tnewline\nsub");
  });
});
