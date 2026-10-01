import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../../../messages/en.json";

/**
 * A refusal the client cannot name falls back to a generic line, and which line
 * depends on what the re-run sent: a regenerate sends no message, so "Couldn't send
 * your message" would be false there — but an edit DOES send one, so "Couldn't start
 * a new reply" is the wrong line for it. Driven through the real hook: a mounted
 * component, the real history load, the real POST.
 */
vi.mock("@/lib/event-stream", () => ({ subscribeEvents: () => () => {} }));
// One translator for every render, as the provider would give: the hook's callbacks
// depend on `t`, so a new one per render would reload history in a loop.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("../../../messages/en.json")).default;
  const t = actual.createTranslator({ locale: "en", messages, namespace: "chat.hook" });
  return { ...actual, useTranslations: () => t };
});

const history = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "Draft the memo" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "Here it is." }] },
];

import { useBackgroundChat } from "@/hooks/use-background-chat";

// The smallest container react-dom accepts: no element is ever rendered into it.
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

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // react-dom reads `window.event` to prioritize an update and looks for a focused
  // iframe around a commit; there is neither here.
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ error: "Internal server error" }, { status: 500 });
    if (url.startsWith("/api/chat?")) return Response.json(history);
    return Response.json(null);
  });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(Probe));
  });
});

afterAll(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("re-run refused for a reason the client can't name", () => {
  it("an edit says the message could not be sent", async () => {
    expect(api.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    let err: unknown;
    await act(async () => { err = await api.editMessage("m1", "Draft the letter").catch((e: unknown) => e); });
    expect((err as Error).message).toBe(en.chat.hook.requestFailed);
  });

  it("a regenerate says a new reply could not be started", async () => {
    let err: unknown;
    await act(async () => { err = await api.regenerate().catch((e: unknown) => e); });
    expect((err as Error).message).toBe(en.chat.hook.rerunFailed);
  });
});
