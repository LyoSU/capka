import { describe, it, expect } from "vitest";
import { normalizeAccountStatus } from "@/lib/auth";

/**
 * The session status coercion is fail-closed: only the three known non-active
 * values survive; everything else collapses to "rejected". The regression this
 * guards is "suspended" being silently coerced away — a suspended session must
 * stay "suspended" (still gated, but distinguishable), never fall back to a
 * value that some gate treats differently.
 */
describe("normalizeAccountStatus", () => {
  it("passes through the four known statuses", () => {
    expect(normalizeAccountStatus("active")).toBe("active");
    expect(normalizeAccountStatus("pending")).toBe("pending");
    expect(normalizeAccountStatus("suspended")).toBe("suspended");
    expect(normalizeAccountStatus("rejected")).toBe("rejected");
  });

  it("coerces anything unknown or missing to rejected (fail-closed)", () => {
    expect(normalizeAccountStatus(undefined)).toBe("rejected");
    expect(normalizeAccountStatus(null)).toBe("rejected");
    expect(normalizeAccountStatus("")).toBe("rejected");
    expect(normalizeAccountStatus("ACTIVE")).toBe("rejected");
    expect(normalizeAccountStatus("banned")).toBe("rejected");
    expect(normalizeAccountStatus(42)).toBe("rejected");
  });

  it("only 'active' is ever the access-granting value", () => {
    const grants = ["active", "pending", "suspended", "rejected", "other"].filter(
      (s) => normalizeAccountStatus(s) === "active",
    );
    expect(grants).toEqual(["active"]);
  });
});
