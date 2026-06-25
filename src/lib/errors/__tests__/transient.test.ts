import { describe, it, expect } from "vitest";
import { isTransientError } from "@/lib/errors/friendly";

describe("isTransientError", () => {
  it("network drops are transient", () => {
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(new Error("fetch failed: ECONNRESET"))).toBe(true);
  });
  it("5xx / overload / rate-limit are transient", () => {
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("502 Bad Gateway")).toBe(true);
    expect(isTransientError("Error 529: overloaded")).toBe(true);
    expect(isTransientError("429 rate limit exceeded")).toBe(true);
  });
  it("auth / credits / invalid-request are NOT transient", () => {
    expect(isTransientError("401 invalid api key")).toBe(false);
    expect(isTransientError("402 insufficient credits")).toBe(false);
    expect(isTransientError("400 messages must alternate")).toBe(false);
  });
});
