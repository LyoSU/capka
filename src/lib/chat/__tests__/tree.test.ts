import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { messages } from "@/lib/db/schema";
import { activePath, descendToLeaf, forkedMessageRow, importedMessageRows, insertMessageChunks, pathRowsWhere, siblingId, turnSuffix, type TreeNode } from "../tree";

// Pure graph tests — no DB, so they run in the normal suite. `createdAt`
// increments per node to give a deterministic sibling order.
let clock = 0;
const n = (id: string, parentId: string | null): TreeNode => ({
  id,
  parentId,
  createdAt: new Date(++clock * 1000),
});

describe("conversation tree", () => {
  it("returns a linear chat root → leaf with no alternatives", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("u2", "a1"), n("a2", "u2")];
    const path = activePath(rows, "a2");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(path.every((p) => p.siblingCount === 1)).toBe(true);
  });

  it("follows the active leaf through an edited branch and exposes ‹ i/N ›", () => {
    // u1 → a1 → u2 → a2   (original)
    //            ↘ u2b → a2b   (u2 edited: sibling under a1)
    const rows = [
      n("u1", null), n("a1", "u1"),
      n("u2", "a1"), n("a2", "u2"),
      n("u2b", "a1"), n("a2b", "u2b"),
    ];
    const path = activePath(rows, "a2b");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1", "u2b", "a2b"]);
    // u2b is the 2nd of two siblings under a1.
    const edited = path.find((p) => p.node.id === "u2b")!;
    expect(edited.siblingCount).toBe(2);
    expect(edited.siblingIndex).toBe(1);
    // Switching back to the original branch shows the first version.
    const orig = activePath(rows, "a2").find((p) => p.node.id === "u2")!;
    expect(orig.siblingIndex).toBe(0);
    expect(orig.siblingCount).toBe(2);
  });

  it("descends to the newest child at each step", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("a1b", "u1"), n("u2", "a1b")];
    // a1b is newer than a1, and u2 hangs off a1b.
    expect(descendToLeaf(rows, "u1")).toBe("u2");
  });

  it("falls back to the newest branch when the active pointer is missing", () => {
    const rows = [n("u1", null), n("a1", "u1"), n("a1b", "u1")];
    const path = activePath(rows, null);
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1b"]); // newest leaf
  });

  it("falls back when the active pointer is stale (points at a deleted node)", () => {
    const rows = [n("u1", null), n("a1", "u1")];
    const path = activePath(rows, "ghost");
    expect(path.map((p) => p.node.id)).toEqual(["u1", "a1"]);
  });

  it("returns nothing for an empty chat", () => {
    expect(activePath([], "whatever")).toEqual([]);
  });

  it("steps between siblings and stops at the edges", () => {
    const rows = [n("u1", null), n("a", "u1"), n("b", "u1"), n("c", "u1")];
    expect(siblingId(rows, "a", "next")).toBe("b");
    expect(siblingId(rows, "b", "next")).toBe("c");
    expect(siblingId(rows, "c", "next")).toBe(null); // at the end
    expect(siblingId(rows, "a", "prev")).toBe(null); // at the start
    expect(siblingId(rows, "b", "prev")).toBe("a");
    expect(siblingId(rows, "ghost", "next")).toBe(null);
  });
});

/**
 * The taint column across the three paths that MINT message rows outside a turn. They are
 * the seventh construction site (see `turn-taint.ts`), they run inside DB functions with no
 * integration coverage, and the mark they omit is invisible: the column is
 * `NOT NULL DEFAULT false`, so a dropped carry produces a chat that reads perfectly and
 * folds clean. These pin the builders themselves, which is the only seam a unit test has.
 */
const sourceRow = (over: Partial<{ untrustedIngress: boolean; metadata: unknown }> = {}) =>
  ({
    id: "src-1",
    chatId: "chat-a",
    parentId: null,
    role: "assistant",
    content: "the page said the invoice is monthly",
    platform: "web",
    metadata: { status: "completed", taskId: "task-live" },
    untrustedIngress: true,
    ...over,
  }) as Parameters<typeof forkedMessageRow>[0];

describe("copied and imported rows carry the taint mark", () => {
  const ids = { id: "new-1", chatId: "chat-b", parentId: null };

  it("a fork of a tainted row stays tainted", () => {
    expect(forkedMessageRow(sourceRow(), ids).untrustedIngress).toBe(true);
  });

  it("a fork of a clean row stays clean - the copy is neither cleaner nor dirtier", () => {
    expect(forkedMessageRow(sourceRow({ untrustedIngress: false }), ids).untrustedIngress).toBe(false);
  });

  it("still strips the live task from a forked row", () => {
    const copy = forkedMessageRow(sourceRow({ metadata: { status: "running", taskId: "t1" } }), ids);
    expect(copy.metadata).toEqual({ status: "completed" });
  });

  it("import rows are born tainted: the text came off another service's share link", () => {
    const rows = importedMessageRows({
      chatId: "chat-c",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      importSource: "chatgpt",
      base: 1_000,
    });
    expect(rows.every((r) => r.untrustedIngress === true)).toBe(true);
    // And the chain the taint rides is still the linear one, newest last.
    expect(rows[0].parentId).toBeNull();
    expect(rows[1].parentId).toBe(rows[0].id);
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[0].createdAt.getTime());
  });
});

describe("turnSuffix — one finished turn onward", () => {
  const r = (id: string, parentId: string | null, role: string) => ({ ...n(id, parentId), role });

  it("starts at the run of user messages the reply answers and runs to the leaf", () => {
    // u2 and u3 folded into one turn answered by a2; u4 was queued behind it.
    const rows = [
      r("u1", null, "user"), r("a1", "u1", "assistant"),
      r("u2", "a1", "user"), r("u3", "u2", "user"), r("a2", "u3", "assistant"),
      r("u4", "a2", "user"),
    ];
    const path = activePath(rows, "u4");
    expect(turnSuffix(path, "a2").map((p) => p.node.id)).toEqual(["u2", "u3", "a2", "u4"]);
    // The first turn has nothing before it to leave out.
    expect(turnSuffix(path, "a1").map((p) => p.node.id)).toEqual(["u1", "a1", "u2", "u3", "a2", "u4"]);
  });

  it("keeps the sibling position a regenerate gave the reply", () => {
    const rows = [r("u1", null, "user"), r("a1", "u1", "assistant"), r("a1b", "u1", "assistant")];
    const tail = turnSuffix(activePath(rows, "a1b"), "a1b");
    expect(tail.map((p) => [p.node.id, p.siblingIndex, p.siblingCount])).toEqual([["u1", 0, 1], ["a1b", 1, 2]]);
  });

  it("is empty for a message off the active branch", () => {
    const rows = [r("u1", null, "user"), r("a1", "u1", "assistant"), r("a1b", "u1", "assistant")];
    expect(turnSuffix(activePath(rows, "a1b"), "a1")).toEqual([]);
  });
});

describe("pathRowsWhere", () => {
  it("binds the path ids as one parameter however long the path is", () => {
    const ids = Array.from({ length: 70000 }, (_, i) => `m${i}`);
    const q = new PgDialect().sqlToQuery(pathRowsWhere("c1", ids)!);
    expect(q.params).toEqual(["c1", ids]);
    expect(q.sql).toContain("= ANY($2::text[])");
  });
});

describe("insertMessageChunks", () => {
  it("splits a long chain so no statement binds more than 65535 parameters, keeping order", async () => {
    const columns = Object.keys(getTableColumns(messages)).length;
    const tables: unknown[] = [];
    const rows = Array.from({ length: 20000 }, (_, i) => ({ id: `m${i}`, chatId: "c", role: "user", content: "x" }));
    const batches: { id: string }[][] = [];
    const tx = {
      insert: (table: unknown) => ({
        values: async (v: { id: string }[]) => {
          tables.push(table);
          batches.push(v);
        },
      }),
    } as unknown as Parameters<typeof insertMessageChunks>[0];
    await insertMessageChunks(tx, rows);
    expect(batches.length).toBeGreaterThan(1);
    expect(tables.every((t) => t === messages)).toBe(true);
    for (const b of batches) expect(b.length * columns).toBeLessThanOrEqual(65535);
    // Full chunks are as large as the cap allows: one more row would overflow it.
    expect((batches[0].length + 1) * columns).toBeGreaterThan(65535);
    expect(batches.at(-1)!.length).toBe(rows.length - batches[0].length * (batches.length - 1));
    expect(batches.flat().map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});
