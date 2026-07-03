import { describe, it, expect } from "vitest";
import { uniquelyNamedPaste } from "../chat-input";

const clip = (name: string, type = "image/png") => new File([new Uint8Array([1, 2, 3])], name, { type });

describe("uniquelyNamedPaste", () => {
  it("gives two pasted screenshots distinct names so they don't collide", () => {
    const a = uniquelyNamedPaste(clip("image.png"));
    const b = uniquelyNamedPaste(clip("image.png"));
    expect(a.name).not.toBe(b.name);
    expect(a.name).not.toBe("image.png");
    expect(a.name.endsWith(".png")).toBe(true);
  });

  it("renames a blank-named clipboard bitmap, keeping its type's extension", () => {
    const renamed = uniquelyNamedPaste(clip("", "image/jpeg"));
    expect(renamed.name).not.toBe("");
    expect(renamed.name.endsWith(".jpeg")).toBe(true);
  });

  it("leaves a real copied filename untouched", () => {
    const original = clip("Q3 report.png");
    expect(uniquelyNamedPaste(original)).toBe(original);
  });
});
