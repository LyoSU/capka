import { describe, it, expect, vi, beforeEach } from "vitest";

// No real controller: capture the render command execute() sends, and feed the
// tool the marker-delimited stdout the render script would produce.
const { execCommand, downloadFile } = vi.hoisted(() => ({ execCommand: vi.fn(), downloadFile: vi.fn() }));
vi.mock("../client", () => ({ execCommand, downloadFile }));

import { makeViewFileTool, buildViewFileInjection, isMediaRef, type MediaRef } from "../view-file";

const lastCmd = (): string => execCommand.mock.calls.at(-1)![1] as string;
const make = (emitImageToolResult = true) =>
  makeViewFileTool({ sessionKey: "sess1", userId: "user1", ensureSession: async () => {}, emitImageToolResult });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = {} as any;
const pngResponse = () => ({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });

describe("view_file — rendering + ref shape", () => {
  beforeEach(() => {
    execCommand.mockReset();
    downloadFile.mockReset();
  });

  it("rasterizes a PDF with pdftoppm and returns a small, base64-free media ref", async () => {
    execCommand.mockResolvedValue({
      stdout: "__COUNT__12\n__PNG__/workspace/.capka/view/ab/p-1.png\n__PNG__/workspace/.capka/view/ab/p-2.png\n",
      stderr: "", exitCode: 0,
    });
    const { view_file } = make();
    const res = (await view_file.execute!({ path: "report.pdf" }, opts)) as MediaRef;
    const cmd = lastCmd();
    expect(cmd).toContain("pdftoppm");
    expect(cmd).toContain("/workspace/.capka/view/");
    expect(isMediaRef(res)).toBe(true);
    expect(res.pageCount).toBe(12);
    expect(res.pages).toEqual([
      { page: 1, path: ".capka/view/ab/p-1.png" },
      { page: 2, path: ".capka/view/ab/p-2.png" },
    ]);
    // the persisted ref must stay tiny — never base64
    expect(JSON.stringify(res).length).toBeLessThan(600);
    expect(JSON.stringify(res)).not.toMatch(/[A-Za-z0-9+/]{200,}={0,2}/);
  });

  it("converts an office doc via LibreOffice before rasterizing", async () => {
    execCommand.mockResolvedValue({ stdout: "__COUNT__1\n__PNG__/workspace/.capka/view/ab/p-1.png\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    await view_file.execute!({ path: "memo.docx" }, opts);
    const cmd = lastCmd();
    expect(cmd).toContain("soffice --headless --convert-to pdf");
    expect(cmd).toContain("pdftoppm");
  });

  it("renders an image via ImageMagick convert (first frame, downscale-only)", async () => {
    execCommand.mockResolvedValue({ stdout: "__COUNT__1\n__PNG__/workspace/.capka/view/ab/p-1.png\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    await view_file.execute!({ path: "photo.jpg" }, opts);
    const cmd = lastCmd();
    expect(cmd).toContain("convert");
    expect(cmd).toContain('-resize \'1536x1536>\'');
  });

  it("screenshots HTML with headless Chromium", async () => {
    execCommand.mockResolvedValue({ stdout: "__COUNT__1\n__PNG__/workspace/.capka/view/ab/p-1.png\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    await view_file.execute!({ path: "page.html" }, opts);
    expect(lastCmd()).toContain("chromium --headless");
  });

  it("caps rendering to 4 pages per call", async () => {
    execCommand.mockResolvedValue({ stdout: "__COUNT__100\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    await view_file.execute!({ path: "big.pdf", pages: [1, 2, 3, 4, 5, 6, 7, 8] }, opts);
    const cmd = lastCmd();
    expect(cmd).toContain("for p in 1 2 3 4;");
  });

  it("rotates old view dirs (keeps a bounded number)", async () => {
    execCommand.mockResolvedValue({ stdout: "__COUNT__1\n__PNG__/workspace/.capka/view/ab/p-1.png\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    await view_file.execute!({ path: "x.pdf" }, opts);
    expect(lastCmd()).toContain("ls -1td");
  });

  it("returns an error for an unsupported file type (no render attempted)", async () => {
    const { view_file } = make();
    const res = (await view_file.execute!({ path: "archive.zip" }, opts)) as { error: string };
    expect(res.error).toContain("read_file");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("returns a not-found error when the render script reports __NOFILE__", async () => {
    execCommand.mockResolvedValue({ stdout: "__NOFILE__\n", stderr: "", exitCode: 0 });
    const { view_file } = make();
    const res = (await view_file.execute!({ path: "missing.pdf" }, opts)) as { error: string };
    expect(res.error).toContain("not found");
  });
});

describe("view_file — capable transport (toModelOutput)", () => {
  beforeEach(() => {
    execCommand.mockReset();
    downloadFile.mockReset();
  });

  it("hydrates the ref into image-data content parts", async () => {
    downloadFile.mockResolvedValue(pngResponse());
    const { view_file } = make(true);
    const ref: MediaRef = {
      kind: "media", source: "report.pdf", mime: "image/png", pageCount: 2,
      pages: [{ page: 1, path: "/workspace/.capka/view/ab/p-1.png" }, { page: 2, path: "/workspace/.capka/view/ab/p-2.png" }],
      note: "x",
    };
    const out = await view_file.toModelOutput!({ output: ref } as never);
    expect(out.type).toBe("content");
    const value = (out as { value: { type: string }[] }).value;
    expect(value.filter((v) => v.type === "image-data")).toHaveLength(2);
    expect(value[0].type).toBe("text");
  });

  it("never throws — a failed download degrades to text", async () => {
    downloadFile.mockRejectedValue(new Error("gone"));
    const { view_file } = make(true);
    const ref: MediaRef = {
      kind: "media", source: "report.pdf", mime: "image/png", pageCount: 1,
      pages: [{ page: 1, path: "/workspace/.capka/view/ab/p-1.png" }], note: "x",
    };
    const out = await view_file.toModelOutput!({ output: ref } as never);
    const value = (out as { value: { type: string }[] }).value;
    expect(value.some((v) => v.type === "image-data")).toBe(false);
    expect(value.some((v) => v.type === "text")).toBe(true);
  });

  it("passes the raw ref through as json on the bridge transport (no image in the tool result)", async () => {
    downloadFile.mockResolvedValue(pngResponse());
    const ref: MediaRef = {
      kind: "media", source: "memo.docx", mime: "image/png", pageCount: 1,
      pages: [{ page: 1, path: ".capka/view/ab/p-1.png" }], note: "x",
    };
    const out = await make(false).view_file.toModelOutput!({ output: ref } as never);
    expect(out.type).toBe("json");
    // no image bytes fetched for the tool result — the pages arrive via prepareStep instead
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

describe("view_file — bridge transport (buildViewFileInjection)", () => {
  beforeEach(() => downloadFile.mockReset());

  const toolMsg = (output: unknown) => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "view_file", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "view_file", output }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;

  it("injects a user message with the rendered pages when the last message is a view_file result", async () => {
    downloadFile.mockResolvedValue(pngResponse());
    const ref: MediaRef = {
      kind: "media", source: "memo.docx", mime: "image/png", pageCount: 1,
      pages: [{ page: 1, path: "/workspace/.capka/view/ab/p-1.png" }], note: "x",
    };
    const msg = await buildViewFileInjection(toolMsg({ type: "json", value: ref }), "sess1", "user1");
    expect(msg?.role).toBe("user");
    const content = msg!.content as { type: string }[];
    expect(content.some((c) => c.type === "image")).toBe(true);
    expect(content.some((c) => c.type === "text")).toBe(true);
  });

  it("returns null when the last message is not a pending view_file result", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = [{ role: "user", content: "hi" }] as any;
    expect(await buildViewFileInjection(msgs, "sess1", "user1")).toBeNull();
  });

  it("returns null for a non-media tool result", async () => {
    const msg = await buildViewFileInjection(toolMsg({ type: "json", value: { ok: true } }), "sess1", "user1");
    expect(msg).toBeNull();
  });
});
