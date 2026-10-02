import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StreamListener } from "@/lib/event-stream";

/**
 * The chat page hands the hook the transcript it rendered with, so opening a chat
 * paints without waiting on the hook's own GET /api/chat. That snapshot is only
 * DRAWN: the load still runs, and everything live — a running turn's status, the
 * seq cursor its deltas reconcile against, `historyLoaded` — still comes from it.
 * The page can be much older than it looks (back/forward replays a cached payload).
 */
let listener: StreamListener;
vi.mock("@/lib/event-stream", () => ({ subscribeEvents: (l: StreamListener) => { listener = l; return () => {}; } }));
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../messages/en.json")).default;
  const t = actual.createTranslator({ locale: "en", messages, namespace: "chat.hook" });
  return { ...actual, useTranslations: () => t };
});

import { useBackgroundChat, type TranscriptMessage } from "@/hooks/use-background-chat";

const msg = (id: string, role: string, text = id, metadata?: Record<string, unknown>): TranscriptMessage =>
  ({ id, role, parts: [{ type: "text", text }], metadata });

// What the server answers to the hook's own load, held open until released so the
// moment before it lands is observable.
let branch: TranscriptMessage[] = [];
let release: () => void = () => {};
let loads = 0;
let task: { id: string; status: string } | null = null;

const fakeDocument = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
const container = {
  nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", textContent: "",
  ownerDocument: fakeDocument, addEventListener() {}, removeEventListener() {},
};

let api: ReturnType<typeof useBackgroundChat>;
let root: Root | undefined;

function Probe({ initialMessages }: { initialMessages?: TranscriptMessage[] }) {
  const chat = useBackgroundChat({ chatId: "c1", initialMessages });
  useEffect(() => { api = chat; });
  return null;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const mount = async (initialMessages?: TranscriptMessage[]) => {
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(createElement(Probe, { initialMessages })); });
  await settle();
};
const land = async () => { await act(async () => { release(); }); await settle(); };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("window", { HTMLIFrameElement: class {}, dispatchEvent() {} });
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/chat?chatId=c1") {
      loads++;
      await new Promise<void>((r) => { release = r; });
      return Response.json(branch);
    }
    if (url.startsWith("/api/tasks?chatId=c1")) return Response.json(task);
    return Response.json(null);
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  loads = 0;
  task = null;
});

afterAll(() => vi.unstubAllGlobals());

describe("a preloaded transcript", () => {
  it("is drawn before the load lands, which still runs and still gates sending", async () => {
    const preloaded = [msg("u1", "user"), msg("a1", "assistant")];
    branch = preloaded.map((m) => ({ ...m }));
    await mount(preloaded);

    expect(api.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(loads).toBe(1);
    expect(api.historyLoaded).toBe(false);

    await land();
    expect(api.historyLoaded).toBe(true);
    // The same answer keeps the array the page drew: nothing re-renders for it.
    expect(api.messages).toBe(preloaded);
  });

  it("gives way to a load that answers differently", async () => {
    const preloaded = [msg("u1", "user"), msg("a1", "assistant", "old")];
    branch = [msg("u1", "user"), msg("a1", "assistant", "old"), msg("u2", "user"), msg("a2", "assistant", "newer")];
    await mount(preloaded);
    await land();

    expect(api.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("does not adopt a running turn from the snapshot — only from the load", async () => {
    // A page replayed from the back/forward cache: the turn it caught running has
    // since finished, and the load knows it.
    const preloaded = [msg("u1", "user"), msg("a1", "assistant", "half", { taskStatus: "running", taskId: "t1", streamSeq: 3, runningMs: 1000 })];
    branch = [msg("u1", "user"), msg("a1", "assistant", "whole", { taskStatus: "completed" })];
    await mount(preloaded);

    expect(api.status).toBe("idle");
    await land();
    expect(api.status).toBe("idle");
    expect((api.messages[1].parts[0] as { text: string }).text).toBe("whole");
  });

  it("joins a turn that IS still running once the load says so, and streams onto the load's copy", async () => {
    const preloaded = [msg("u1", "user"), msg("a1", "assistant", "he", { taskStatus: "running", taskId: "t1", streamSeq: 1 })];
    branch = [msg("u1", "user"), msg("a1", "assistant", "hello", { taskStatus: "running", taskId: "t1", streamSeq: 2 })];
    task = { id: "t1", status: "running" };
    await mount(preloaded);
    await land();

    expect(api.status).toBe("running");
    // Seq 2 is already in the load's copy, so it is ignored; 3 is the next one. (A trailing
    // space, because the pacer holds back a word that may still be growing.)
    await act(async () => { listener.onMessage!({ chatId: "c1", type: "task:text-delta", messageId: "a1", delta: "llo", seq: 2 } as never); });
    await act(async () => { listener.onMessage!({ chatId: "c1", type: "task:text-delta", messageId: "a1", delta: " there ", seq: 3 } as never); });
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect((api.messages[1].parts[0] as { text: string }).text).toBe("hello there ");
  });

  it("leaves a chat with nothing preloaded exactly as it was", async () => {
    branch = [msg("u1", "user")];
    await mount();

    expect(api.messages).toEqual([]);
    await land();
    expect(api.messages.map((m) => m.id)).toEqual(["u1"]);
  });
});
