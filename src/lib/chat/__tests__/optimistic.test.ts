import { describe, it, expect } from "vitest";
import { mergePendingMessages, pendingStillUnknown } from "../optimistic";

type Msg = { id: string; role: string };

describe("mergePendingMessages", () => {
  it("re-appends a queued message the reloaded history doesn't yet contain", () => {
    // The bug: a task:finish for the previous turn reloads history before the
    // just-queued message B has committed. The server path lacks B; without the
    // merge it would vanish from the chat until the next reload.
    const history: Msg[] = [
      { id: "a", role: "user" },
      { id: "assistant-1", role: "assistant" },
    ];
    const pending: Msg[] = [{ id: "b", role: "user" }];

    const merged = mergePendingMessages(history, pending);

    expect(merged.map((m) => m.id)).toEqual(["a", "assistant-1", "b"]);
  });

  it("does not duplicate a pending message the server has caught up to", () => {
    const history: Msg[] = [
      { id: "a", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "b", role: "user" },
    ];
    const pending: Msg[] = [{ id: "b", role: "user" }];

    expect(mergePendingMessages(history, pending).map((m) => m.id)).toEqual([
      "a",
      "assistant-1",
      "b",
    ]);
  });

  it("returns history untouched when nothing is pending", () => {
    const history: Msg[] = [{ id: "a", role: "user" }];
    expect(mergePendingMessages(history, [])).toBe(history);
  });

  it("preserves send order for a burst of queued follow-ups", () => {
    const history: Msg[] = [{ id: "a", role: "user" }];
    const pending: Msg[] = [
      { id: "b", role: "user" },
      { id: "c", role: "user" },
    ];
    expect(mergePendingMessages(history, pending).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("pendingStillUnknown", () => {
  it("drops entries the server history now contains, keeps the rest", () => {
    const history: Msg[] = [
      { id: "a", role: "user" },
      { id: "b", role: "user" },
    ];
    const pending: Msg[] = [
      { id: "b", role: "user" },
      { id: "c", role: "user" },
    ];
    expect(pendingStillUnknown(history, pending).map((m) => m.id)).toEqual(["c"]);
  });

  it("returns the same array reference when nothing is pending", () => {
    const pending: Msg[] = [];
    expect(pendingStillUnknown([{ id: "a", role: "user" }], pending)).toBe(pending);
  });
});
