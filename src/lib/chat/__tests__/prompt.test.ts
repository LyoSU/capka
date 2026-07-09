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

describe("buildSystemPrompt — network state", () => {
  it("tells the model it has network when egress is bridged", () => {
    const p = buildSystemPrompt({ networkMode: "bridge" });
    expect(p.stable).toContain("outbound network access");
    expect(p.stable).not.toContain("no network access");
  });

  it("tells the model there is no network when egress is cut, and defaults to no network when unspecified", () => {
    const off = buildSystemPrompt({ networkMode: "none" });
    expect(off.stable).toContain("no network access");
    expect(off.stable).not.toContain("outbound network access");

    // Safe default: absent an explicit mode, assume no egress.
    expect(buildSystemPrompt({}).stable).toContain("no network access");
  });
});
