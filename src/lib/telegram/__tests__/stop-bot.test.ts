import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// stopBot() used to return with pieces still sitting in the burst collector, so a
// restart inside the burst window dropped an already-received Telegram message
// with no task, no reply and no error. The collector is the only place those
// pieces exist, so the shutdown path has to flush it — this pins the wiring, not
// the collector (see burst.test.ts for the flush itself).
const { add, drainAll } = vi.hoisted(() => ({ add: vi.fn(), drainAll: vi.fn(async () => {}) }));
vi.mock("@/lib/telegram/burst", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/burst")>();
  return {
    ...actual,
    createBurstCollector: () => ({ add, drain: vi.fn(async () => {}), drainAll }),
  };
});

// bot.ts pulls the whole platform in at module scope; almost none of it is
// exercised by a stop with no turn in flight, so stub the modules that would
// open a socket. The token makes buildBot() produce a bot, which is what lets
// this file drive the real message handlers.
vi.mock("@/lib/db", () => ({ db: {}, pool: { connect: vi.fn() } }));
vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async () => "123:TESTTOKEN"),
  setSetting: vi.fn(async () => {}),
}));

// A stand-in for grammY that records the handlers buildBot registers, so a fake
// update can be fed to the real one (`message:document`) without a network or a
// getMe round-trip. Only the surface buildBot touches is implemented.
const handlers = new Map<string, (ctx: unknown) => unknown>();
vi.mock("grammy", () => {
  class Bot {
    api = { deleteWebhook: vi.fn(async () => {}), setMyCommands: vi.fn(async () => {}) };
    on(filter: string | string[], h: (ctx: unknown) => unknown) {
      handlers.set(Array.isArray(filter) ? filter.join(",") : filter, h);
      return this;
    }
    command() { return this; }
    callbackQuery() { return this; }
    catch() { return this; }
    async start() {}
    async stop() {}
  }
  class InlineKeyboard {
    url() { return this; }
    text() { return this; }
  }
  return { Bot, InlineKeyboard };
});

import { getBot, stopBot } from "../bot";

beforeEach(() => {
  vi.useFakeTimers();
  add.mockClear();
  drainAll.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("stopBot", () => {
  it("flushes every open burst before returning", async () => {
    await stopBot();
    expect(drainAll).toHaveBeenCalledTimes(1);
  });

  it("still returns when the flush itself fails (a stuck shutdown is worse)", async () => {
    drainAll.mockRejectedValueOnce(new Error("ingest exploded"));
    await expect(stopBot()).resolves.toBeUndefined();
    expect(drainAll).toHaveBeenCalledTimes(1);
  });
});

// A media group waits out its OWN 1.5s debounce before it even reaches the burst
// collector, so draining the collector alone still lost an album Telegram had
// already delivered — the half of finding 16 that stayed open.
describe("stopBot with a media group still inside its debounce", () => {
  const mediaFilter = [
    "message:photo",
    "message:document",
    "message:video",
    "message:audio",
    "message:voice",
    "message:animation",
    "message:video_note",
  ].join(",");

  const albumPart = (groupId: string, fileId: string, caption?: string) => ({
    chat: { id: 500, type: "group" },
    from: { id: 900 },
    message: {
      media_group_id: groupId,
      document: { file_id: fileId, file_name: `${fileId}.pdf`, mime_type: "application/pdf" },
      ...(caption ? { caption } : {}),
    },
    replyWithChatAction: vi.fn(async () => {}),
  });

  it("flushes the album into the burst collector before draining it", async () => {
    await getBot(); // registers the real handlers on the stand-in bot
    const onMedia = handlers.get(mediaFilter);
    expect(onMedia).toBeDefined();

    await onMedia!(albumPart("g1", "one", "compare these two"));
    await onMedia!(albumPart("g1", "two"));
    // Still inside ALBUM_DEBOUNCE_MS: nothing has reached the collector yet.
    expect(add).not.toHaveBeenCalled();

    await stopBot();

    // Both parts arrive as ONE piece, caption included, keyed by chat + sender.
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe(500);
    expect(add.mock.calls[0][1]).toBe(900);
    expect(add.mock.calls[0][2].text).toBe("compare these two");
    expect(add.mock.calls[0][2].files.map((f: { fileId: string }) => f.fileId)).toEqual(["one", "two"]);
    // And the collector is drained AFTER the album lands in it, or the flush
    // would have nothing to send.
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(drainAll.mock.invocationCallOrder[0]);
  });

  it("leaves no album timer behind, so a second stop is a no-op", async () => {
    await getBot();
    const onMedia = handlers.get(mediaFilter)!;
    await onMedia(albumPart("g2", "solo"));
    await stopBot();
    expect(add).toHaveBeenCalledTimes(1);
    // The debounce is cancelled by the early flush, not merely defused by the
    // map lookup: a live timer pointing at a deleted entry outlives the buffer
    // it belonged to.
    expect(vi.getTimerCount()).toBe(0);

    add.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(add).not.toHaveBeenCalled();
  });
});

// Poll leadership used to be handed over BEFORE the flush, so the new leader
// could serve this user's /new (which re-pins their active chat) while the old
// process was still ingesting — the buffered text then landed in the chat they
// had just left.
describe("stopBot ordering of the poller handover", () => {
  it("releases the poll lock only after the buffers are drained", async () => {
    const release = vi.fn();
    const state = (globalThis as unknown as { __telegramBot?: { leaderClient: unknown } }).__telegramBot;
    expect(state).toBeDefined();
    state!.leaderClient = { release };

    await stopBot();

    expect(release).toHaveBeenCalledTimes(1);
    expect(drainAll).toHaveBeenCalledTimes(1);
    expect(drainAll.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    expect(state!.leaderClient).toBeNull();
  });
});
