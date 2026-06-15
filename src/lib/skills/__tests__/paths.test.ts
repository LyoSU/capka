import { describe, it, expect } from "vitest";
import { sanitizeBundlePath } from "../paths";

describe("sanitizeBundlePath", () => {
  it("accepts a normal relative path", () => {
    expect(sanitizeBundlePath("scripts/run.py")).toBe("scripts/run.py");
  });
  it("strips a leading ./", () => {
    expect(sanitizeBundlePath("./reference.md")).toBe("reference.md");
  });
  it("rejects traversal", () => {
    expect(sanitizeBundlePath("../etc/passwd")).toBeNull();
    expect(sanitizeBundlePath("scripts/../../x")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(sanitizeBundlePath("/etc/passwd")).toBeNull();
  });
  it("rejects empty / dot-only", () => {
    expect(sanitizeBundlePath("")).toBeNull();
    expect(sanitizeBundlePath(".")).toBeNull();
  });
  it("normalizes backslashes", () => {
    expect(sanitizeBundlePath("scripts\\win.ps1")).toBe("scripts/win.ps1");
  });
});
