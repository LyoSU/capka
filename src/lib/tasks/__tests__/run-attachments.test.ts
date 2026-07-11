import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "ai";

vi.mock("@/lib/sandbox/client", () => ({
  downloadFile: vi.fn(),
  execCommand: vi.fn(),
}));

import { downloadFile, execCommand } from "@/lib/sandbox/client";
import { injectNativeFiles } from "../run-attachments";
import { MAX_NATIVE_FILE_BYTES } from "@/lib/constants";

const dl = vi.mocked(downloadFile);
const exec = vi.mocked(execCommand);

/** A downloadFile result stub — the code only ever reads `arrayBuffer()`. */
const asResponse = (buf: Buffer) =>
  ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }) as unknown as Response;

function userMessages(text = "look at this"): ModelMessage[] {
  return [{ role: "user", content: text }];
}

function fileParts(msgs: ModelMessage[]) {
  const last = msgs.findLast((m) => m.role === "user");
  const content = last?.content;
  return Array.isArray(content) ? content.filter((p) => p.type === "file") : [];
}

beforeEach(() => {
  dl.mockReset();
  exec.mockReset();
  // Default: downscale reports the source already small enough → keep original.
  exec.mockResolvedValue({ stdout: "__KEEP__", stderr: "", exitCode: 0 });
});

describe("injectNativeFiles — honest injected-set return", () => {
  it("returns only the files whose bytes actually reached the model", async () => {
    dl.mockResolvedValue(asResponse(Buffer.alloc(1024)));
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "openai", [
      { name: "a.txt", type: "text/plain" },
      { name: "b.txt", type: "text/plain" },
    ]);
    expect(injected.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(fileParts(msgs)).toHaveLength(2);
  });

  it("does NOT report a file the sandbox download failed for", async () => {
    dl.mockImplementation(async (_s, path) =>
      path === "good.txt" ? asResponse(Buffer.alloc(1024)) : Promise.reject(new Error("gone")),
    );
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "openai", [
      { name: "good.txt", type: "text/plain" },
      { name: "gone.txt", type: "text/plain" },
    ]);
    // The false-native bug: the caller must not announce gone.txt as inline.
    expect(injected.map((f) => f.name)).toEqual(["good.txt"]);
    expect(fileParts(msgs)).toHaveLength(1);
  });

  it("drops a file over the per-file byte cap and omits it from the return", async () => {
    dl.mockResolvedValue(asResponse(Buffer.alloc(MAX_NATIVE_FILE_BYTES + 1)));
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "openai", [
      { name: "huge.pdf", type: "application/pdf" },
    ]);
    expect(injected).toEqual([]);
    expect(fileParts(msgs)).toHaveLength(0);
  });

  it("stops at the aggregate budget, reporting only what fit", async () => {
    // Three 19 MiB files: two fit under the 50 MiB aggregate, the third spills.
    dl.mockResolvedValue(asResponse(Buffer.alloc(19 * 1024 * 1024)));
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "openai", [
      { name: "1.pdf", type: "application/pdf" },
      { name: "2.pdf", type: "application/pdf" },
      { name: "3.pdf", type: "application/pdf" },
    ]);
    expect(injected.map((f) => f.name)).toEqual(["1.pdf", "2.pdf"]);
    expect(fileParts(msgs)).toHaveLength(2);
  });

  it("returns [] and touches nothing when there is no user message", async () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: "hi" }];
    const injected = await injectNativeFiles(msgs, "sess", "u1", "openai", [{ name: "a.txt", type: "text/plain" }]);
    expect(injected).toEqual([]);
    expect(dl).not.toHaveBeenCalled();
  });
});

describe("injectNativeFiles — image downscale", () => {
  it("injects the downscaled copy but maps the return back to the ORIGINAL ref", async () => {
    exec.mockResolvedValue({ stdout: "__DONE__", stderr: "", exitCode: 0 });
    let requested = "";
    dl.mockImplementation(async (_s, path) => {
      requested = path;
      return asResponse(Buffer.alloc(400 * 1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "photo.jpg", type: "image/jpeg" },
    ]);
    // Downloaded the hidden downscaled copy…
    expect(requested).toMatch(/^\.capka\/native-img\/.+\/0\.jpg$/);
    // …but announces the user's original path, which stays intact in /workspace.
    expect(injected).toEqual([{ name: "photo.jpg", type: "image/jpeg" }]);
    expect(fileParts(msgs)).toHaveLength(1);
    // A downscale + its cleanup both go through execCommand.
    expect(exec).toHaveBeenCalled();
  });

  it("keeps the original when the image is already under the downscale threshold", async () => {
    exec.mockResolvedValue({ stdout: "__KEEP__", stderr: "", exitCode: 0 });
    const seen: string[] = [];
    dl.mockImplementation(async (_s, path) => {
      seen.push(path);
      return asResponse(Buffer.alloc(200 * 1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "small.png", type: "image/png" },
    ]);
    expect(seen).toEqual(["small.png"]);
    expect(injected).toEqual([{ name: "small.png", type: "image/png" }]);
  });

  it("falls back to the original when the downscale command fails", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "convert: boom", exitCode: 1 });
    const seen: string[] = [];
    dl.mockImplementation(async (_s, path) => {
      seen.push(path);
      return asResponse(Buffer.alloc(1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "photo.webp", type: "image/webp" },
    ]);
    expect(seen).toEqual(["photo.webp"]);
    expect(injected).toEqual([{ name: "photo.webp", type: "image/webp" }]);
  });
});
