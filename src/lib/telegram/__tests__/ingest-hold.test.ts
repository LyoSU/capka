import { describe, it, expect, vi, beforeEach } from "vitest";
import { telegramLinks, chats, messages, tasks } from "@/lib/db/schema";
import { ValidationError } from "@/lib/errors";
import en from "../../../../messages/en.json";

// A Telegram turn reserves a budget hold, then saves the message, moves the leaf and
// enqueues. The hold has to be released on every path that does not hand it to a
// created task — and on none that does. A throw while saving the message used to
// leak it (no task row, so only the hour-late orphan sweep finds it); a throw AFTER a created
// enqueue used to release the hold of a turn that was about to run.

// The burst collector is the only way into `ingest`; capture its flush callback.
const { flush } = vi.hoisted(() => ({ flush: { fn: undefined as undefined | ((chatId: number, batch: unknown) => Promise<void>) } }));
vi.mock("@/lib/telegram/burst", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/burst")>();
  return {
    ...actual,
    createBurstCollector: (cb: (chatId: number, batch: unknown) => Promise<void>) => {
      flush.fn = cb;
      return { add: vi.fn(), drain: vi.fn(async () => {}), drainAll: vi.fn(async () => {}) };
    },
  };
});

const reserveBudget = vi.fn();
const releaseHold = vi.fn();
vi.mock("@/lib/billing/limits", () => ({
  reserveBudget: (...a: unknown[]) => reserveBudget(...a),
  releaseHold: (...a: unknown[]) => releaseHold(...a),
}));
const resolveUserModelInfo = vi.fn();
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: (...a: unknown[]) => resolveUserModelInfo(...a),
}));
const take = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ take: (...a: unknown[]) => take(...a) }));
const enqueueTask = vi.fn();
const settleMovedPast = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  settleMovedPast: (...a: unknown[]) => settleMovedPast(...a),
  requestCancel: vi.fn(),
  cancelQueuedTurn: vi.fn(),
  ORPHAN_HOLD_AGE_MS: 60 * 60_000,
}));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent: vi.fn(async () => {}) }));

// Reads are answered per TABLE, so each lookup ingest makes gets its own row: the
// link (joined to its account's status and role), the pinned chat, and the "is
// another turn running" probe.
const state: { messageInsert?: Error; runningProbe?: Error; role: string } = { role: "user" };
const chatRow: { id: string; userId: string; title: string; model: null; projectId: null; activeLeafId: string | null; leafStatus: string | null } =
  { id: "chat1", userId: "u1", title: "Hi", model: null, projectId: null, activeLeafId: null, leafStatus: null };
// Every write the message makes, in order, with the handle it went through.
const writes: { what: string; via: unknown }[] = [];
const rowsFor = (table: unknown) => {
  if (table === telegramLinks) return [{ id: "link1", userId: "u1", telegramUserId: 42, activeChatId: "chat1", status: "active", role: state.role }];
  if (table === chats) return [chatRow];
  if (table === tasks) {
    if (state.runningProbe) throw state.runningProbe;
    return [];
  }
  throw new Error("unexpected table");
};
vi.mock("@/lib/db", () => {
  const handle = (name: string) => ({
    name,
    select: () => ({
      from: (table: unknown) => {
        const q = { where: () => ({ limit: async () => rowsFor(table) }), innerJoin: () => q };
        return q;
      },
    }),
    insert: (table: unknown) => ({
      values: async () => {
        if (table === messages && state.messageInsert) throw state.messageInsert;
        writes.push({ what: "insert", via: name });
      },
    }),
    update: () => ({ set: () => ({ where: async () => { writes.push({ what: "update", via: name }); } }) }),
  });
  return {
    pool: { connect: vi.fn() },
    db: { ...handle("db"), transaction: async (fn: (tx: unknown) => unknown) => fn(handle("tx")) },
  };
});
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) }));

await import("../bot");

const ctx = () => ({
  chat: { id: 42, type: "private" },
  from: { id: 42, language_code: "en" },
  message: { message_id: 7 },
  replyWithChatAction: vi.fn(async () => {}),
  replyWithRichMessage: vi.fn(async () => {}),
});
const send = (c = ctx()) => flush.fn!(42, { ctx: c, text: "hello", files: [] }).then(() => c);
const heldTaskId = () => reserveBudget.mock.calls[0][0].taskId as string;

beforeEach(() => {
  writes.length = 0;
  chatRow.activeLeafId = null;
  chatRow.leafStatus = null;
  settleMovedPast.mockReset().mockImplementation(async (_id: string, tx: unknown) => {
    writes.push({ what: "settle", via: (tx as { name?: string } | undefined)?.name });
  });
  state.messageInsert = undefined;
  state.runningProbe = undefined;
  state.role = "user";
  resolveUserModelInfo.mockReset().mockResolvedValue({ isShared: true, modelId: "m", provider: "p", configId: "cfg" });
  take.mockReset().mockReturnValue({ ok: true });
  reserveBudget.mockReset().mockResolvedValue({ allowed: true, window: null, reason: null });
  releaseHold.mockReset().mockResolvedValue(undefined);
  enqueueTask.mockReset().mockImplementation(async (t: { id: string }) => ({ id: t.id, created: true }));
});

describe("telegram ingest budget hold", () => {
  it("releases the hold when saving the message throws before any task exists", async () => {
    state.messageInsert = new Error("db down");
    const c = await send();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
    // The user is told it did not start, instead of hearing nothing.
    expect(c.replyWithRichMessage).toHaveBeenCalledOnce();
  });

  it("hands the hold to the created task and releases nothing", async () => {
    await send();
    expect(enqueueTask.mock.calls[0][0].id).toBe(heldTaskId());
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("releases the hold when the message folds into an already-queued turn", async () => {
    enqueueTask.mockResolvedValue({ id: "incumbent", created: false });
    await send();
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
  });

  // The hold exists before the task row, and the orphan-hold sweep releases a hold
  // with no task row after an hour. A download that never answers used to keep the
  // turn in that state indefinitely; now one deadline, far inside the hour, ends it.
  it("stops waiting for a hung file download at the deadline and still hands the hold to the turn", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      // Never answers on its own; only the signal it is given can end it.
      const getFile = vi.fn((_id: string, signal?: AbortSignal) => new Promise((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      }));
      const c = { ...ctx(), api: { getFile } };
      const files = [{ fileId: "f1", fileName: "a.jpg", mime: "image/jpeg" }, { fileId: "f2", fileName: "b.jpg", mime: "image/jpeg" }];
      const sent = flush.fn!(42, { ctx: c, text: "hello", files });
      await vi.waitFor(() => expect(getFile).toHaveBeenCalledOnce());
      expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(15 * 60_000);
      deadline.abort();
      await sent;
      expect(getFile).toHaveBeenCalledTimes(2); // the second file is not waited on either
      expect(enqueueTask.mock.calls[0][0].id).toBe(heldTaskId());
      expect(enqueueTask.mock.calls[0][0].payload.attachedFiles).toBeUndefined();
      expect(releaseHold).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps the hold of a created task when a later step throws", async () => {
    state.runningProbe = new Error("probe failed");
    const c = await send();
    expect(releaseHold).not.toHaveBeenCalled();
    // The turn is live, so "could not start" would be a lie.
    expect(c.replyWithRichMessage).not.toHaveBeenCalled();
  });

  // A model whose provider was removed resolves with a ValidationError. It used to
  // escape the try and die in the burst collector's log: the user heard nothing.
  it("tells the user to pick another model when theirs cannot be resolved, and holds nothing", async () => {
    resolveUserModelInfo.mockRejectedValue(new ValidationError("Model config not found"));
    const c = await send();
    expect(c.replyWithRichMessage).toHaveBeenCalledWith({ markdown: en.telegram.modelUnavailable }, undefined);
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("does not turn an unexpected resolver failure into a reply", async () => {
    resolveUserModelInfo.mockRejectedValue(new Error("db"));
    const c = await send();
    expect(c.replyWithRichMessage).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  // The web refuses a viewer on /api/chat; Telegram used to check status only.
  it("refuses a read-only viewer before the flood guard or the budget", async () => {
    state.role = "viewer";
    const c = await send();
    expect(c.replyWithRichMessage).toHaveBeenCalledWith({ markdown: en.telegram.readOnly }, undefined);
    expect(take).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  // Typing instead of tapping the card the reply waits on goes past it. Left live, the
  // card kept the web composer blocked and fed every later turn a call with no result.
  it("settles the card its chat's leaf still waits on, in the same transaction as the message", async () => {
    chatRow.activeLeafId = "a1";
    chatRow.leafStatus = "awaiting_approval";
    await send();
    expect(settleMovedPast).toHaveBeenCalledOnce();
    expect(settleMovedPast.mock.calls[0][0]).toBe("a1");
    expect(writes).toEqual([
      { what: "insert", via: "tx" }, { what: "update", via: "tx" }, { what: "settle", via: "tx" },
    ]);
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).not.toBe("a1");
  });

  // The common case pays for no transaction and no extra read: the leaf's status came
  // with the chat row.
  it("chains onto a leaf that waits on nothing with plain writes and settles nothing", async () => {
    chatRow.activeLeafId = "a1";
    chatRow.leafStatus = "completed";
    await send();
    expect(settleMovedPast).not.toHaveBeenCalled();
    expect(writes).toEqual([{ what: "insert", via: "db" }, { what: "update", via: "db" }]);
    expect(enqueueTask.mock.calls[0][0].payload.replyParentId).not.toBe("a1");
  });

  it("settles nothing in a chat with no messages yet", async () => {
    await send();
    expect(settleMovedPast).not.toHaveBeenCalled();
  });

  it("says it could not start without showing the raw error", async () => {
    state.messageInsert = new Error('relation "x" does not exist');
    const c = await send();
    expect(c.replyWithRichMessage).toHaveBeenCalledWith({ markdown: en.telegram.startError }, undefined);
    expect(JSON.stringify(c.replyWithRichMessage.mock.calls)).not.toContain("relation");
    expect(releaseHold).toHaveBeenCalledWith(heldTaskId());
  });
});
