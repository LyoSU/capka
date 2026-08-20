import { describe, it, expect } from "vitest";
import { pickLruVictim, nextBusyUntil } from "./session-policy.js";

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

  it("sacrifices a disposable import (imp-*) session before any chat, even a more-idle one", () => {
    // At cap of 3; 'a' is the most idle, but imp-x is a one-shot import container
    // and is evicted first regardless of recency.
    const sessions = [live("imp-x", 99), live("a", 1), live("b", 2)];
    expect(pickLruVictim(sessions, 3, "new").sessionId).toBe("imp-x");
  });

  it("evicts the least-recently-used import when several are live", () => {
    const sessions = [live("imp-x", 50), live("imp-y", 10), live("a", 1)];
    expect(pickLruVictim(sessions, 3, "new").sessionId).toBe("imp-y");
  });

  it("falls back to plain LRU when no import session is live", () => {
    const sessions = [live("a", 30), live("b", 10), live("c", 20)];
    expect(pickLruVictim(sessions, 3, "new").sessionId).toBe("b");
  });

  // A session holding a background-job lease is spared where possible: killing it
  // destroys work in progress, while evicting an idle one only costs a restart.
  const busy = (id, ts, until) => ({ ...live(id, ts), busyUntil: until });

  it("spares a session with a live lease when a free one can be evicted instead", () => {
    // 'a' is the most idle but is running a job; 'b' is free and goes instead.
    const sessions = [busy("a", 1, 5000), live("b", 20), live("c", 30)];
    expect(pickLruVictim(sessions, 3, "new", 1000).sessionId).toBe("b");
  });

  it("evicts the LRU leaseholder when every candidate is busy", () => {
    // Never return null just because everything is busy — that would block the
    // user from opening a chat at all.
    const sessions = [busy("a", 30, 5000), busy("b", 10, 5000)];
    expect(pickLruVictim(sessions, 2, "new", 1000).sessionId).toBe("b");
  });

  it("treats an expired lease as free", () => {
    const sessions = [busy("a", 1, 500), live("b", 20)];
    expect(pickLruVictim(sessions, 2, "new", 1000).sessionId).toBe("a");
  });

  it("prefers a free chat over a busy import", () => {
    // Free-vs-busy outranks the import shortcut: an import holding a lease is
    // still doing work, an idle chat is not.
    const sessions = [busy("imp-x", 99, 5000), live("a", 1)];
    expect(pickLruVictim(sessions, 2, "new", 1000).sessionId).toBe("a");
  });

  it("still sacrifices an import first among busy sessions", () => {
    const sessions = [busy("imp-x", 99, 5000), busy("a", 1, 5000)];
    expect(pickLruVictim(sessions, 2, "new", 1000).sessionId).toBe("imp-x");
  });
});

describe("nextBusyUntil", () => {
  const HOUR = 3_600_000;
  const lease = { leaseMs: HOUR, maxMs: 6 * HOUR };

  it("opens a fresh window when the session holds no lease", () => {
    expect(nextBusyUntil({ busySince: null, busyUntil: null, now: 1000, ...lease }))
      .toEqual({ busySince: 1000, busyUntil: 1000 + HOUR });
  });

  it("extends a held lease without moving its start", () => {
    // Taken at 1000, renewed half an hour later: the ceiling still counts from 1000.
    const held = { busySince: 1000, busyUntil: 1000 + HOUR };
    expect(nextBusyUntil({ ...held, now: 1000 + HOUR / 2, ...lease }))
      .toEqual({ busySince: 1000, busyUntil: 1000 + HOUR / 2 + HOUR });
  });

  it("clamps a renewal to the absolute ceiling", () => {
    // 5h30m into a 6h ceiling: a full hour would overshoot, so it stops at the ceiling.
    const held = { busySince: 0, busyUntil: 5.75 * HOUR };
    expect(nextBusyUntil({ ...held, now: 5.5 * HOUR, ...lease }).busyUntil).toBe(6 * HOUR);
  });

  it("starts a new window once the previous lease has expired", () => {
    // The job died and a later one starts: the old ceiling must not carry over.
    const stale = { busySince: 0, busyUntil: HOUR };
    expect(nextBusyUntil({ ...stale, now: 10 * HOUR, ...lease }))
      .toEqual({ busySince: 10 * HOUR, busyUntil: 11 * HOUR });
  });

  it("caps the very first lease when it is longer than the ceiling", () => {
    expect(nextBusyUntil({ busySince: null, busyUntil: null, now: 0, leaseMs: 9 * HOUR, maxMs: 6 * HOUR }))
      .toEqual({ busySince: 0, busyUntil: 6 * HOUR });
  });
});
