import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../../../messages/en.json";
import type { StreamListener } from "@/lib/event-stream";

/**
 * A finished turn is read back on its own and spliced in where our copy has it,
 * rather than reloading the whole branch; and an edit that keeps only files still
 * sends words. Driven through the real hook, as in use-background-chat.rerun.test:
 * a mounted component, the real history load, the real SSE handler.
 */
let listener: StreamListener;
vi.mock("@/lib/event-stream", () => ({ subscribeEvents: (l: StreamListener) => { listener = l; return () => {}; } }));
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../messages/en.json")).default;
  const t = actual.createTranslator({ locale: "en", messages, namespace: "chat.hook" });
  return { ...actual, useTranslations: () => t };
});

import { useBackgroundChat } from "@/hooks/use-background-chat";

type Msg = { id: string; role: string; parts: { type: string; text: string }[]; metadata?: Record<string, unknown> };
const msg = (id: string, role: string, text = id, metadata?: Record<string, unknown>): Msg =>
  ({ id, role, parts: [{ type: "text", text }], metadata });

// What the server answers: the whole branch, and the turn read back from a message on.
let branch: Msg[] = [];
let turn: Msg[] | null = null;
// Holds the turn read-back open until released, so the moment before it lands is observable.
let turnGate: Promise<void> | null = null;
let fullLoads = 0;
const posts: Record<string, unknown>[] = [];
let postReply: () => Promise<Response> = async () => Response.json({ taskId: "t-new" });

const fakeDocument = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
const container = {
  nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", textContent: "",
  ownerDocument: fakeDocument, addEventListener() {}, removeEventListener() {},
};

let api: ReturnType<typeof useBackgroundChat>;
let root: Root;

function Probe() {
  const chat = useBackgroundChat({ chatId: "c1" });
  useEffect(() => { api = chat; });
  return null;
}

const ids = () => api.messages.map((m) => m.id);
const textAt = (i: number) => (api.messages.at(i)!.parts[0] as { text: string }).text;
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const emit = async (event: Record<string, unknown>) => {
  await act(async () => { listener.onMessage!({ chatId: "c1", taskId: "t1", ...event } as never); });
  await settle();
};
/** Remount with `branch` as the server's copy, so each case starts from a fresh load. */
const mount = async () => {
  if (root) await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(createElement(Probe)); });
  await settle();
  fullLoads = 0;
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("window", { HTMLIFrameElement: class {}, dispatchEvent() {} });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return postReply();
    }
    if (url === "/api/chat?chatId=c1") {
      fullLoads++;
      return Response.json(branch);
    }
    if (url.startsWith("/api/chat?chatId=c1&messageId=")) {
      if (turnGate) await turnGate;
      return turn ? Response.json(turn) : new Response(null, { status: 500 });
    }
    return Response.json(null);
  });
});

beforeEach(() => {
  posts.length = 0;
  postReply = async () => Response.json({ taskId: "t-new" });
});

afterAll(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("a finished turn is spliced in, not reloaded", () => {
  it("replaces our copy from the turn's first message on, and drops what the server no longer has", async () => {
    branch = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("stale", "assistant")];
    await mount();
    turn = [msg("u2", "user"), msg("a2", "assistant", "final")];

    await emit({ type: "task:finish", messageId: "a2", status: "completed" });

    expect(ids()).toEqual(["u1", "a1", "u2", "a2"]);
    expect(textAt(3)).toBe("final");
    expect(fullLoads).toBe(0);
  });

  it("keeps a reply that already started behind the turn, in place", async () => {
    branch = [msg("u1", "user"), msg("a1", "assistant", "partial")];
    await mount();
    // The next turn's task:start beat the finished turn's read-back.
    await emit({ type: "task:start", messageId: "a-next" });
    turn = [msg("u1", "user"), msg("a1", "assistant", "final")];

    await emit({ type: "task:finish", messageId: "a1", status: "completed" });

    expect(ids()).toEqual(["u1", "a1", "a-next"]);
    expect(textAt(1)).toBe("final");
    expect(fullLoads).toBe(0);
  });

  it("keeps a send whose POST has not come back, ahead of its reply", async () => {
    branch = [msg("u1", "user"), msg("a1", "assistant", "partial")];
    await mount();
    let release!: () => void;
    postReply = () => new Promise((r) => { release = () => r(Response.json({ taskId: "t2" })); });
    let sent!: Promise<void>;
    await act(async () => { sent = api.sendMessage("and another", "m", undefined, "u-mid"); });
    // Its reply can start before the POST answers.
    await emit({ type: "task:start", messageId: "a-mid" });
    turn = [msg("u1", "user"), msg("a1", "assistant", "final")];

    await emit({ type: "task:finish", messageId: "a1", status: "completed" });

    expect(ids()).toEqual(["u1", "a1", "u-mid", "a-mid"]);
    expect(fullLoads).toBe(0);
    await act(async () => { release(); await sent; });
  });

  // Each road the splice cannot vouch for is the full reload's.
  it.each([
    ["the turn begins outside our copy", () => { turn = [msg("u-elsewhere", "user"), msg("a2", "assistant")]; }],
    ["a row in it is still running", () => {
      turn = [msg("u1", "user"), msg("a2", "assistant", "", { taskStatus: "running" })];
    }],
    ["the read-back fails", () => { turn = null; }],
  ])("reloads the branch when %s", async (_road, arrange) => {
    branch = [msg("u1", "user"), msg("a1", "assistant")];
    await mount();
    arrange();

    await emit({ type: "task:finish", messageId: "a2", status: "completed" });

    expect(fullLoads).toBe(1);
  });

  it("reloads the branch for a finish that names no reply", async () => {
    branch = [msg("u1", "user"), msg("a1", "assistant")];
    await mount();
    turn = [msg("u1", "user")];

    await emit({ type: "task:finish", status: "failed" });

    expect(fullLoads).toBe(1);
  });
});

describe("an edit that keeps only files", () => {
  const files = [{ name: "q3.pdf", type: "application/pdf" }];

  it("sends the placeholder words with the files, as a sibling of the original", async () => {
    branch = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user", "look at this", { attachedFiles: files }), msg("a2", "assistant")];
    await mount();

    await act(async () => { await api.editMessage("u2", "  "); });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ userMessage: en.chat.hook.processFiles, parentId: "a1", attachedFiles: files });
    // The optimistic bubble says the same words the server will store.
    expect(textAt(-1)).toBe(en.chat.hook.processFiles);
  });

  it("sends nothing once the files are gone too", async () => {
    branch = [msg("u1", "user", "look at this", { attachedFiles: files }), msg("a1", "assistant")];
    await mount();

    await act(async () => { await api.editMessage("u1", "", undefined, []); });

    expect(posts).toEqual([]);
    expect(ids()).toEqual(["u1", "a1"]);
  });
});

describe("a tool that throws while the reply is on screen", () => {
  it("carries the thrown message as errorText, as the reloaded row does", async () => {
    const call = { type: "dynamic-tool", toolCallId: "tc1", toolName: "save_row", state: "approval-responded", input: {} };
    branch = [msg("u1", "user"), { id: "a1", role: "assistant", parts: [call] } as unknown as Msg];
    await mount();

    await emit({ type: "task:tool-result", messageId: "a1", toolCallId: "tc1", result: { error: "disk full" }, isError: true });

    // An approval card reads "interrupted" for an output-error with no errorText.
    expect(api.messages[1].parts[0]).toMatchObject({ state: "output-error", errorText: "disk full" });
  });
});

// The send queue goes out the moment the chat reads idle and no card waits
// (chat-panel's drain). A finished turn whose card is not in our copy yet — the
// finish seen by the poll while SSE was down, or a task:tool-approval held past a
// gap and dropped at task:finish — must not read as free until its rows are back.
describe("a turn that ended on a card is not free until its rows are back", () => {
  const call = { type: "dynamic-tool", toolCallId: "tc1", toolName: "save_row", input: {} };
  const running = () => ({ id: "a1", role: "assistant", parts: [{ ...call, state: "input-available" }], metadata: { taskStatus: "running" } }) as unknown as Msg;
  const waiting = () => ({ id: "a1", role: "assistant", parts: [{ ...call, state: "approval-requested", approval: { id: "ap1" } }], metadata: { taskStatus: "awaiting_approval" } }) as unknown as Msg;
  const drainable = () => !api.isLoading && !api.awaitingInput && !api.settling;

  afterEach(() => { turnGate = null; vi.useRealTimers(); });

  it.each([
    ["the poll notices the finish while SSE is down", async () => {
      await act(async () => { vi.advanceTimersByTime(3000); });
      await settle();
    }],
    ["task:finish arrives with the approval event lost to a gap", () => emit({ type: "task:finish", messageId: "a1", status: "awaiting_approval" })],
  ])("holds while %s", async (_road, finish) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    branch = [msg("u1", "user"), running()];
    await mount();
    expect(api.isLoading).toBe(true);
    turn = [msg("u1", "user"), waiting()];
    let release!: () => void;
    turnGate = new Promise((r) => { release = r; });

    await finish();

    expect(api.isLoading).toBe(false);
    expect(drainable()).toBe(false);
    await act(async () => { release(); });
    await settle();
    expect(api.awaitingInput).toBe(true);
    expect(drainable()).toBe(false);
  });

  it("frees the chat once the rows are back and nothing waits", async () => {
    branch = [msg("u1", "user"), running()];
    await mount();
    turn = [msg("u1", "user"), msg("a1", "assistant", "done")];

    await emit({ type: "task:finish", messageId: "a1", status: "completed" });

    expect(drainable()).toBe(true);
  });
});
