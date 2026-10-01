import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { probeFile, recheckFiles, useFileStatus } from "../file-preview";

/**
 * A file chip asks once whether its file is there and then trusts the answer, so a
 * file deleted while the chip stayed mounted kept looking clickable until a remount.
 * recheckFiles is how the page says the workspace may have changed; chips naming the
 * same file must still cost one request between them.
 */
describe("file status probes", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = () => {
    const calls: ((status: number) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      calls.push((status) => resolve(new Response(null, { status })));
    })));
    return calls;
  };
  const file = { path: "report.pdf", name: "report.pdf", chatId: "c1" };

  it("asks once for chips that name the same file", async () => {
    const calls = stubFetch();
    const a = probeFile(file);
    const b = probeFile(file);
    expect(calls).toHaveLength(1);
    calls[0](200);
    expect(await a).toBe("ok");
    expect(await b).toBe("ok");
  });

  it("asks again after a recheck, not trusting an answer that may predate the change", async () => {
    const calls = stubFetch();
    const before = probeFile(file);
    recheckFiles();
    const after = probeFile(file);
    expect(calls).toHaveLength(2);
    calls[0](200);
    calls[1](404);
    expect(await before).toBe("ok");
    expect(await after).toBe("gone");
  });

  it("after a turn that could only have created files, asks again for the chips showing gone and no others", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("window", { HTMLIFrameElement: class {} });
    const exists = new Set(["kept.md"]);
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = decodeURIComponent(/path=([^&]+)/.exec(url)![1]);
      asked.push(path);
      return new Response(null, { status: exists.has(path) ? 200 : 404 });
    }));
    const seen: Record<string, string> = {};
    function Chip({ path }: { path: string }) {
      const status = useFileStatus({ path, name: path, chatId: "c2" });
      useEffect(() => { seen[path] = status; });
      return null;
    }
    const container = {
      nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", textContent: "",
      ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {},
    };
    const root = createRoot(container as unknown as HTMLElement);
    const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { root.render([createElement(Chip, { key: 1, path: "kept.md" }), createElement(Chip, { key: 2, path: "notes.md" })]); });
    await settle();
    expect(seen).toEqual({ "kept.md": "ok", "notes.md": "gone" });

    exists.add("notes.md"); // the agent writes it again
    asked.length = 0;
    await act(async () => recheckFiles("gone"));
    await settle();
    expect(asked).toEqual(["notes.md"]);
    expect(seen["notes.md"]).toBe("ok");
    await act(async () => root.unmount());
  });
});
