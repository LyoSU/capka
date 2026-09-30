import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/chat?chatId=&messageId= — what a client reads after `task:finish`: that
 * turn onward, not the whole branch. Every finished turn used to re-read and
 * re-render every message of the chat, off-branch rows and all tool outputs
 * included, just to pick up the rows that one turn changed.
 */
const { requireSession, requireOwned, readTurnWrites } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireOwned: vi.fn(),
  readTurnWrites: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));
vi.mock("@/lib/vault/turn-writes", () => ({ readTurnWrites }));
vi.mock("@/lib/providers/resolve", () => ({ resolveUserModelInfo: vi.fn() }));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget: vi.fn(), releaseHold: vi.fn() }));
vi.mock("@/lib/tasks/queue", () => ({ enqueueTask: vi.fn() }));

//   u1 → a1 → u2 → a2old
//               ↘ a2      (regenerated; the active leaf)
//        a1 → u2b → a2b   (an edited branch, off the active path)
let clock = 0;
const row = (id: string, parentId: string | null, role: string) => ({
  id, chatId: "c1", parentId, role, content: `${id} text`, platform: "web",
  metadata: { status: "completed", parts: [{ type: "text", text: `${id} text` }] },
  createdAt: new Date(++clock * 1000),
});
const store = [
  row("u1", null, "user"), row("a1", "u1", "assistant"),
  row("u2", "a1", "user"), row("a2old", "u2", "assistant"), row("a2", "u2", "assistant"),
  row("u2b", "a1", "user"), row("a2b", "u2b", "assistant"),
];

// Which ids each full-row read asked for — the point of the change is that only the
// rows being returned are read in full.
const fullReads = vi.hoisted(() => ({ ids: [] as unknown[][] }));
vi.mock("@/lib/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  return {
    db: {
      select: (fields?: Record<string, unknown>) => ({
        from: () => ({
          where: (pred: never) => {
            // The skeleton read names its columns; the full read takes the row.
            if (fields) {
              return Promise.resolve(store.map((r) => ({ id: r.id, parentId: r.parentId, createdAt: r.createdAt, role: r.role })));
            }
            const { params } = new PgDialect().sqlToQuery(pred);
            fullReads.ids.push(params);
            return Promise.resolve(store.filter((r) => params.includes(r.id)));
          },
        }),
      }),
    },
  };
});

import { GET } from "@/app/api/chat/route";

const get = async (qs: string) => {
  const res = await GET(new Request(`http://x/api/chat?${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; metadata: { siblingIndex: number; siblingCount: number; memoryWrites?: unknown } }[];
};

beforeEach(() => {
  fullReads.ids = [];
  requireSession.mockReset().mockResolvedValue({ userId: "u", role: "user", status: "active" });
  requireOwned.mockReset().mockResolvedValue({ id: "c1", userId: "u", activeLeafId: "a2" });
  readTurnWrites.mockReset().mockResolvedValue({ a2: [{ kind: "fact", id: "f1", text: "likes tea" }] });
});

describe("GET /api/chat with messageId", () => {
  it("returns only the finished turn, with its sibling position and memory notice", async () => {
    const msgs = await get("chatId=c1&messageId=a2");

    expect(msgs.map((m) => m.id)).toEqual(["u2", "a2"]);
    // The regenerated reply is the second of two versions — what the ‹ 2/2 › reads.
    expect(msgs[1].metadata).toMatchObject({ siblingIndex: 1, siblingCount: 2 });
    // u2 is the older of the two user messages under a1 (u2b is its edit).
    expect(msgs[0].metadata).toMatchObject({ siblingIndex: 0, siblingCount: 2 });
    expect(msgs[1].metadata.memoryWrites).toEqual([{ kind: "fact", id: "f1", text: "likes tea" }]);

    // Only the returned rows were read in full, and only they were asked about memory.
    expect(fullReads.ids).toHaveLength(1);
    expect(fullReads.ids[0].filter((p) => p !== "c1").sort()).toEqual(["a2", "u2"]);
    expect(readTurnWrites).toHaveBeenCalledWith(["u2", "a2"], "u");
  });

  it("answers empty for a message off the active branch, so the client reloads in full", async () => {
    expect(await get("chatId=c1&messageId=a2b")).toEqual([]);
    expect(fullReads.ids).toHaveLength(0);
  });

  it("still returns the whole active branch without messageId, reading no off-branch row in full", async () => {
    const msgs = await get("chatId=c1");

    expect(msgs.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(fullReads.ids[0].filter((p) => p !== "c1").sort()).toEqual(["a1", "a2", "u1", "u2"]);
  });
});
