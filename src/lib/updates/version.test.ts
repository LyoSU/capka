import { describe, it, expect } from "vitest";
import { parseVersion, compareVersions, isUpdateAvailable } from "./version";

describe("parseVersion", () => {
  it("parses v-prefixed and bare semver", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion(" v0.1.0 ")).toEqual([0, 1, 0]);
    expect(parseVersion("v1.4.0-rc.1")).toEqual([1, 4, 0]); // pre-release suffix ignored
  });

  it("returns null for non-release values", () => {
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.0", "v1.1.5")).toBeGreaterThan(0);
    expect(compareVersions("v1.1.2", "v1.1.1")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "v1.2.0")).toBeLessThan(0);
  });

  it("treats unparseable inputs as uncomparable (0)", () => {
    expect(compareVersions("dev", "v1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "latest")).toBe(0);
  });
});

describe("isUpdateAvailable", () => {
  it("is true only when latest is a strictly newer release", () => {
    expect(isUpdateAvailable("v1.0.0", "v1.0.1")).toBe(true);
    expect(isUpdateAvailable("v1.0.0", "v1.0.0")).toBe(false);
    expect(isUpdateAvailable("v1.1.0", "v1.0.9")).toBe(false);
  });

  it("never nags a local dev build (uncomparable current)", () => {
    expect(isUpdateAvailable("dev", "v9.9.9")).toBe(false);
  });
});
