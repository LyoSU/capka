import { describe, it, expect, vi, beforeEach } from "vitest";
import { telegramLinks, users, chats, messages, tasks } from "@/lib/db/schema";

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
vi.mock("@/lib/providers/resolve", () => ({
  resolveUserModelInfo: async () => ({ isShared: true, modelId: "m", provider: "p", configId: "cfg" }),
}));
const enqueueTask = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({
  enqueueTask: (...a: unknown[]) => enqueueTask(...a),
  requestCancel: vi.fn(),
  cancelQueuedTurn: vi.fn(),
}));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent: vi.fn(async () => {}) }));

// Reads are answered per TABLE, so each lookup ingest makes gets its own row: the
// link, the user's status, the pinned chat, and the "is another turn running" probe.
const state: { messageInsert?: Error; runningProbe?: Error } = {};
const linkRow = { id: "link1", userId: "u1", telegramUserId: 42, activeChatId: "chat1" };
const chatRow = { id: "chat1", userId: "u1", title: "Hi", model: null, projectId: null, activeLeafId: null };
const rowsFor = (table: unknown) => {
  if (table === telegramLinks) return [linkRow];
  if (table === users) return [{ status: "active" }];
  if (table === chats) return [chatRow];
  if (table === tasks) {
    if (state.runningProbe) throw state.runningProbe;
    return [];
  }
  throw new Error("unexpected table");
};
vi.mock("@/lib/db", () => ({
  pool: { connect: vi.fn() },
  db: {
    select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => rowsFor(table) }) }) }),
    insert: (table: unknown) => ({
      values: async () => {
        if (table === messages && state.messageInsert) throw state.messageInsert;
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));
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
  state.messageInsert = undefined;
  state.runningProbe = undefined;
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
});
