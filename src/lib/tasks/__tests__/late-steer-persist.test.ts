import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The steers a turn never folded in have to become a real message row, and the two
// terminal paths that owe that are the normal finalize AND the catch that handles a
// thrown provider/setup error. This exercises the write itself against a fake db,
// then pins that the catch path actually reaches it.
const stored = vi.hoisted(() => ({ steers: [] as { id: string; text: string; at: string }[] }));
const writes = vi.hoisted(() => ({
  inserted: [] as { table: string; values: Record<string, unknown> }[],
  updated: [] as { table: string; values: Record<string, unknown>; where: unknown }[],
  // What the leaf-move CAS is told it matched. 1 = we took the leaf, 0 = the person's
  // own concurrent send already had it.
  leafRowCount: 1 as number,
}));

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  return {
    pool: { query: async () => ({ rows: [{ steers: stored.steers }] }) },
    db: {
      insert: (table: never) => ({
        values: (values: Record<string, unknown>) => {
          writes.inserted.push({ table: getTableName(table), values });
          return Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() });
        },
      }),
      update: (table: never) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            writes.updated.push({ table: getTableName(table), values, where });
            return Promise.resolve({ rowCount: writes.leafRowCount });
          },
        }),
      }),
    },
  };
});

const { persistUnreadSteers } = await import("../runner");

const steer = (id: string, text: string) => ({ id, text, at: new Date().toISOString() });
const call = (over: Partial<Parameters<typeof persistUnreadSteers>[0]> = {}) =>
  persistUnreadSteers({
    taskId: "t1", chatId: "c1", parentId: "assistant-msg", platform: "web",
    carried: [], read: 0, ...over,
  });

beforeEach(() => {
  stored.steers = [];
  writes.inserted = [];
  writes.updated = [];
  writes.leafRowCount = 1;
});

/** Every bound parameter inside a drizzle condition, in order, so a test can assert
 *  what the CAS compares without depending on how the dialect renders it. Walks
 *  `queryChunks` and keeps only `Param.value`; a `StringChunk` carries its literal
 *  SQL text in an ARRAY under the same key, which is what the array check drops. */
function boundValues(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return out;
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) boundValues(c, out);
  else if ("value" in n && !Array.isArray(n.value)) out.push(n.value);
  return out;
}

describe("persistUnreadSteers", () => {
  it("writes the unread steers as one user message under the reply", async () => {
    stored.steers = [steer("s1", "also chart it"), steer("s2", "and in euros")];
    const kept = await call();
    expect(kept).toEqual({ messageId: expect.any(String), count: 2, activated: true });
    expect(writes.inserted).toHaveLength(1);
    const row = writes.inserted[0];
    expect(row.table).toBe("messages");
    expect(row.values.role).toBe("user");
    expect(row.values.parentId).toBe("assistant-msg");
    // One message carrying both, in the order they were said.
    expect(row.values.content).toBe("also chart it\n\nand in euros");
  });

  it("moves the chat's active leaf onto it, so the next turn carries the words", async () => {
    stored.steers = [steer("s1", "wait, in euros")];
    const kept = await call();
    expect(writes.updated).toHaveLength(1);
    expect(writes.updated[0].table).toBe("chats");
    expect(writes.updated[0].values.activeLeafId).toBe(kept!.messageId);
    expect(kept!.activated).toBe(true);
  });

  // The move is conditional on the reply this steer hangs off still being the leaf.
  // An unconditional write raced the person: `task:finish` unblocks their composer,
  // so a message sent in the same breath inserts its own child of the same assistant
  // row and moves the leaf — and the write here then yanked it back, abandoning what
  // they had just pressed send on.
  it("compares against the parent reply before taking the leaf", async () => {
    stored.steers = [steer("s1", "one more thing")];
    await call();
    // Exactly two: the chat, and the parent reply. An id-only condition — the
    // unconditional write this replaced — yields just ["c1"] and fails here.
    expect(boundValues(writes.updated[0].where)).toEqual(["c1", "assistant-msg"]);
  });

  it("keeps the steer row when the person's own send won the leaf", async () => {
    // A lost CAS is an outcome, not an error: the row stays as a sibling branch of
    // their newer send, reachable through the "‹ i/N ›" switcher, so nothing they
    // said is lost — and the more recent intent keeps the visible branch.
    writes.leafRowCount = 0;
    stored.steers = [steer("s1", "also in euros")];
    const kept = await call();
    expect(kept).toEqual({ messageId: expect.any(String), count: 1, activated: false });
    // Written, and neither deleted nor retried.
    expect(writes.inserted).toHaveLength(1);
    expect(writes.inserted[0].values.content).toBe("also in euros");
    expect(writes.updated).toHaveLength(1);
  });

  // The read cursor is what keeps a consumed steer from being said twice: it is
  // already inside the reply the model wrote.
  it("writes nothing when the turn folded every steer in", async () => {
    stored.steers = [steer("s1", "already folded")];
    expect(await call({ read: 1 })).toBeNull();
    expect(writes.inserted).toEqual([]);
    expect(writes.updated).toEqual([]);
  });

  it("writes nothing when no steer was ever sent", async () => {
    expect(await call()).toBeNull();
    expect(writes.inserted).toEqual([]);
  });

  // A turn suspended for approval hands its unread steers to the continuation task,
  // which is a different row — so they arrive as `carried`, not from this task's own
  // column, and they were said first.
  it("puts the suspended half's carried steers ahead of this task's own", async () => {
    stored.steers = [steer("s2", "second")];
    const kept = await call({ carried: [steer("s1", "first")] });
    expect(kept?.count).toBe(2);
    expect(writes.inserted[0].values.content).toBe("first\n\nsecond");
  });
});

// The behavioural version of this needs `runAgentTask` against a live database, and
// those suites are RUN_INTEGRATION-gated, so it would not run in this job at all —
// the same reason config-check.test.ts and step-control.test.ts assert on this file's
// source. NAMED WEAKNESS: it pins that the call is REACHED on the throwing path, not
// what the row ends up looking like; the rows are covered by the cases above.
describe("the path that handles a thrown turn keeps the steers too", () => {
  const runner = readFileSync(new URL("../runner.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // `isAbort` is declared once, at the top of the catch that finalizes a turn that
  // threw — so everything after it is that path and nothing before it is.
  const thrownPath = runner.slice(runner.indexOf('const isAbort = e instanceof Error'));

  it("persists the unread steers instead of dropping them", () => {
    expect(thrownPath).not.toBe("");
    expect(thrownPath).toContain("persistUnreadSteers(");
  });

  it("never answers them from there — a turn that just broke is not a reply", () => {
    // Asked, not assumed: `lateSteerPlan` returns answer:false for both statuses
    // this path can produce, and no enqueue may appear alongside the persist.
    expect(thrownPath).toContain("lateSteerPlan(");
    const persist = thrownPath.indexOf("persistUnreadSteers(");
    expect(thrownPath.slice(persist)).not.toContain("enqueueTask(");
  });

  it("keeps the recovery inside a guard, so it cannot break the error handling", () => {
    const persist = thrownPath.indexOf("persistUnreadSteers(");
    const guardOpen = thrownPath.lastIndexOf("try {", persist);
    const guardCatch = thrownPath.indexOf("catch (steerError)", persist);
    expect(guardOpen).toBeGreaterThan(-1);
    expect(guardCatch).toBeGreaterThan(persist);
  });
});
