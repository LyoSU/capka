import { describe, it, expect, afterEach, vi } from "vitest";
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

describe("the numeric knobs read from the environment", () => {
  /**
   * The EXPORTED value, not the parser behind it. What an operator gets is decided
   * once, at module evaluation, so a test that called a helper would pass while the
   * constant an operator actually runs on stayed wrong. Re-importing with the
   * variable set is the only assertion that covers the real path — resetModules +
   * dynamic import, the same pattern as mcp/__tests__/tool-cache.test.ts.
   */
  const turnCeiling = async (value: string): Promise<number> => {
    vi.resetModules();
    vi.stubEnv("MAX_TURN_TOOL_OUTPUT_CHARS", value);
    return (await import("@/lib/tool-output")).MAX_TURN_TOOL_OUTPUT_CHARS;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("takes a positive integer as written", async () => {
    await expect(turnCeiling("250000")).resolves.toBe(250_000);
  });

  // `-1` is the one that stings, and it is why this is not a cosmetic guard:
  // `turnOutputChars >= -1` is already true at zero characters, so the runner sets
  // `toolChoice: "none"` on the first step and every turn answers without ever
  // touching the sandbox. checkConfig reports such a value at boot in the words
  // "the built-in default will be used instead"; these cases are what make that
  // sentence true rather than a claim about a mechanism that does not exist.
  it.each([
    { value: "-1", why: "a negative ceiling silences tools from the first step" },
    { value: "0", why: "zero is not a budget" },
    { value: "1.5", why: "a fraction is a typo, not a budget" },
    { value: "Infinity", why: "not an integer" },
    { value: "400k", why: "Number() reads it as NaN" },
    { value: "", why: "empty means unset" },
  ])("falls back to the default for $value — $why", async ({ value }) => {
    await expect(turnCeiling(value)).resolves.toBe(400_000);
  });

  it("holds the per-call budgets to the same rule", async () => {
    // One rule for all three knobs in the file, because checkConfig validates them
    // with one rule: fixing the turn ceiling alone would leave two knobs whose boot
    // diagnostic still describes something the code does not do.
    vi.resetModules();
    vi.stubEnv("MAX_TOOL_OUTPUT_CHARS", "-1");
    vi.stubEnv("MAX_TOOL_OUTPUT_LINES", "0");
    const mod = await import("@/lib/tool-output");
    expect(mod.MAX_TOOL_OUTPUT_CHARS).toBe(30_000);
    expect(mod.DEFAULT_READ_LINES).toBe(1500);
  });
});
