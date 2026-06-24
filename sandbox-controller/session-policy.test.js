import { describe, it, expect } from "vitest";
import { pickLruVictim } from "./session-policy.js";

const live = (id, ts, handle = "c") => ({ sessionId: id, lastActivity: ts, handle });

describe("pickLruVictim", () => {
  it("returns null when under the live cap", () => {
    expect(pickLruVictim([live("a", 1)], 2, "new")).toBeNull();
  });

  it("evicts the least-recently-used live session at the cap", () => {
    const sessions = [live("a", 30), live("b", 10), live("c", 20)];
    expect(pickLruVictim(sessions, 3, "new").sessionId).toBe("b");
  });

  it("ignores stopped workspaces (null handle) when counting the cap", () => {
    // Two rows but only one LIVE container → under a cap of 2, no eviction.
    const sessions = [live("a", 5), live("b", 1, null)];
    expect(pickLruVictim(sessions, 2, "new")).toBeNull();
  });

  it("never evicts the session being created/revived itself", () => {
    // 'self' is live but excluded; only 'a' remains → under cap of 1? others=1 == cap → evict 'a'.
    const sessions = [live("self", 1), live("a", 99)];
    expect(pickLruVictim(sessions, 1, "self").sessionId).toBe("a");
  });

  it("treats others.length == maxLive as 'at cap' (evicts)", () => {
    expect(pickLruVictim([live("a", 1)], 1, "new").sessionId).toBe("a");
  });
});
