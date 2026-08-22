import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A hard crash never reaches the runner's finalize, so the zombie reconciler — not
 * `interruptedError` — is what most interrupted turns are actually told. It wrote
 * one flat "interrupted" whatever the turn had left behind, which is the same
 * "start over" advice the timeout path just stopped giving. These pin the two
 * halves the SQL cannot check for itself: that the reconciler produces the partial
 * category at all, and that its sentences stay the friendly errors' own.
 */
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ pool: { query, connect: vi.fn() } }));
vi.mock("@/lib/realtime", () => ({ realtime: { publish: vi.fn(), subscribe: vi.fn() } }));

import { reconcileZombies, INTERRUPTED_MESSAGE, INTERRUPTED_PARTIAL_MESSAGE } from "../queue";
import { INTERRUPTED_ERROR, INTERRUPTED_PARTIAL_ERROR } from "@/lib/errors/friendly";

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
});

describe("reconciler interruption copy", () => {
  it("says exactly what the runner says for the same state", () => {
    // Two hand-written sentences for one state drift, and they had: the reconciler
    // said "The task was interrupted before it finished", the runner "This task was
    // interrupted and didn't finish" — same event, different words depending on
    // which code path happened to win the race.
    expect(INTERRUPTED_MESSAGE).toBe(INTERRUPTED_ERROR.userMessage);
    expect(INTERRUPTED_PARTIAL_MESSAGE).toBe(INTERRUPTED_PARTIAL_ERROR.userMessage);
  });
});

describe("reconcileZombies", () => {
  it("writes the partial category, not one flat interrupted", async () => {
    await reconcileZombies();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("interrupted_partial");
  });

  it("decides partial from the evidence the turn left in the row", async () => {
    // The SQL twin of producedWork: finished text, a tool result, or a tool that
    // ran and threw. Reasoning and an unanswered tool call are not work.
    await reconcileZombies();
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("tool-result");
    expect(sql).toContain("tool-error");
    expect(sql).not.toContain("'reasoning'");
  });

  it("hands each reaped task its own verdict, so the live tab is told what the row says", async () => {
    query.mockResolvedValue({
      rows: [
        { id: "t1", user_id: "u1", chat_id: "c1", partial: true },
        { id: "t2", user_id: "u1", chat_id: "c2", partial: false },
      ],
    });
    expect(await reconcileZombies()).toEqual([
      { id: "t1", user_id: "u1", chat_id: "c1", partial: true },
      { id: "t2", user_id: "u1", chat_id: "c2", partial: false },
    ]);
  });
});
