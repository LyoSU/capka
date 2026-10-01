import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The assistant's pick-a-folder card attaches through the bridge, not through the
 * hook's connect(), so the hook's folder list — the one the turn's push and pull walk —
 * never saw that folder until a reload. The card now announces the attach.
 */
vi.mock("@/lib/folder-bridge/bridge", () => ({ supportsLiveSync: () => true, reconnect: async () => "ok" }));

import { useFolderSync } from "../use-folder-sync";
import { chatTarget } from "@/lib/workspace-target";

let rows: { id: string; kind: string; name: string }[] = [];
let api: ReturnType<typeof useFolderSync>;
let root: Root;
const target = chatTarget("c1");
const ensureChat = async () => {};

function Probe() {
  const sync = useFolderSync({ target, ensureChat });
  useEffect(() => { api = sync; });
  return null;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const container = {
  nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", textContent: "",
  ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {},
};

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("fetch", async (url: string) =>
    url === "/api/folders/access" ? Response.json({ canAttach: true }) : Response.json({ folders: rows }));
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(createElement(Probe)); });
  await settle();
});

afterAll(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("useFolderSync", () => {
  it("lists a folder attached elsewhere on the page once that attach is announced", async () => {
    expect(api.folders).toEqual([]);
    rows = [{ id: "f1", kind: "pc", name: "reports" }];
    await act(async () => { window.dispatchEvent(new Event("folders:changed")); });
    await settle();
    expect(api.folders).toEqual([{ id: "f1", name: "reports" }]);
  });
});
