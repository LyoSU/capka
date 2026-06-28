import { describe, it, expect } from "vitest";
import { clampOutput } from "@/lib/tool-output";

describe("clampOutput", () => {
  it("leaves output within budget untouched", () => {
    const r = clampOutput("hello\nworld");
    expect(r).toEqual({ text: "hello\nworld", clipped: false });
  });

  it("clip mode keeps the head and the tail, drops the middle, and marks the seam", () => {
    const text = "HEAD" + "x".repeat(60_000) + "TAIL";
    const r = clampOutput(text, { maxChars: 1000, note: "narrow it" });
    expect(r.clipped).toBe(true);
    expect(r.text.startsWith("HEAD")).toBe(true);
    expect(r.text.endsWith("TAIL")).toBe(true);
    expect(r.text).toContain("TRUNCATED");
    expect(r.text).toContain("NOT the program's real output"); // disambiguates the gap from real output
    expect(r.text).toContain("narrow it");
    expect(r.text.length).toBeLessThan(text.length);
  });

  it("head mode keeps the first lines and reports how many were hidden", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = clampOutput(text, { mode: "head", maxLines: 10 });
    expect(r.clipped).toBe(true);
    expect(r.text.startsWith("line 0\nline 1")).toBe(true);
    expect(r.text).not.toContain("line 99");
    expect(r.text).toContain("showing the first 10 of 100");
  });
});
