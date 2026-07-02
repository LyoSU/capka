import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt";

describe("buildSystemPrompt — concierge", () => {
  it("adds the one-time first-run concierge nudge only when concierge is set, and keeps it out of the cached prefix", () => {
    const withNudge = buildSystemPrompt({ concierge: true });
    const without = buildSystemPrompt({ concierge: false });

    // The nudge lives in the volatile tier (fires once — must not pollute the
    // cache-stable prefix that every other turn reuses).
    expect(withNudge.volatile).toContain("First run");
    expect(withNudge.volatile.toLowerCase()).toContain("manage");
    expect(withNudge.stable).not.toContain("First run");

    // Off by default — an ordinary turn never sees it.
    expect(without.volatile).not.toContain("First run");
  });
});
