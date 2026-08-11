import { describe, it, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * `navigator.clipboard` only exists in a SECURE context. Capka is routinely
 * self-hosted at a bare `http://<ip>:3000`, where the whole async Clipboard API
 * is simply absent — every copy button silently did nothing there. So the helper
 * has to fall back to the legacy `execCommand("copy")` path.
 *
 * The DOM here is a stub: the environment is node, and what's under test is the
 * decision (which path, and what it reports back), not textarea styling.
 */
function stubDocument(execResult: boolean | (() => boolean)) {
  const selected: string[] = [];
  const el = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(() => selected.push(el.value)),
    setSelectionRange: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => el),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: vi.fn(() => (typeof execResult === "function" ? execResult() : execResult)),
  };
  vi.stubGlobal("document", doc);
  return { doc, el, selected };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyToClipboard", () => {
  it("uses the async Clipboard API when the context is secure", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc } = stubDocument(false);

    expect(await copyToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(doc.execCommand).not.toHaveBeenCalled(); // no pointless DOM churn
  });

  it("falls back to execCommand when the Clipboard API is missing (plain-http deploy)", async () => {
    vi.stubGlobal("navigator", {}); // insecure context: no `clipboard` at all
    const { doc, el } = stubDocument(true);

    expect(await copyToClipboard("plain http")).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(el.value).toBe("plain http");
    expect(doc.body.removeChild).toHaveBeenCalled(); // the scratch node is cleaned up
  });

  it("falls back when the Clipboard API exists but rejects (permission denied)", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) } });
    const { doc } = stubDocument(true);

    expect(await copyToClipboard("denied")).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure instead of throwing when no path works", async () => {
    vi.stubGlobal("navigator", {});
    const { doc } = stubDocument(false);

    expect(await copyToClipboard("nope")).toBe(false);
    expect(doc.body.removeChild).toHaveBeenCalled(); // still cleaned up on failure
  });

  it("cleans up even if execCommand throws", async () => {
    vi.stubGlobal("navigator", {});
    const { doc } = stubDocument(() => { throw new Error("boom"); });

    expect(await copyToClipboard("nope")).toBe(false);
    expect(doc.body.removeChild).toHaveBeenCalled();
  });

  it("reports failure rather than throwing when the cleanup itself fails", async () => {
    // The node was never appended, so removing it throws. That throw happens in a
    // `finally`, where it would otherwise REPLACE the value the function returned
    // and surface as an unhandled rejection in the click handler.
    vi.stubGlobal("navigator", {});
    const { doc } = stubDocument(true);
    doc.body.appendChild.mockImplementation(() => { throw new Error("detached"); });
    doc.body.removeChild.mockImplementation(() => { throw new Error("NotFoundError"); });

    await expect(copyToClipboard("nope")).resolves.toBe(false);
  });
});
