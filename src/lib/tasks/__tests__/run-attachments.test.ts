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

function partTypes(msgs: ModelMessage[]) {
  const last = msgs.findLast((m) => m.role === "user");
  const content = last?.content;
  return Array.isArray(content) ? content.map((p) => p.type) : [];
}

beforeEach(() => {
  dl.mockReset();
  exec.mockReset();
  // Default: normalize reports the source already fine → keep original.
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

describe("injectNativeFiles — image normalization", () => {
  it("injects the re-encoded copy but maps the return back to the ORIGINAL ref", async () => {
    exec.mockResolvedValue({ stdout: "__DONE__ jpg", stderr: "", exitCode: 0 });
    let requested = "";
    dl.mockImplementation(async (_s, path) => {
      requested = path;
      return asResponse(Buffer.alloc(400 * 1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "photo.jpg", type: "image/jpeg" },
    ]);
    // Downloaded the hidden normalized copy…
    expect(requested).toMatch(/^\.capka\/native-img\/.+\/0\.jpg$/);
    // …but announces the user's original path, which stays intact in /workspace.
    expect(injected).toEqual([{ name: "photo.jpg", type: "image/jpeg" }]);
    expect(fileParts(msgs)).toHaveLength(1);
    expect(exec).toHaveBeenCalled();
  });

  it("converts a non-native format (HEIC → JPEG) and still returns the original ref", async () => {
    exec.mockResolvedValue({ stdout: "__DONE__ jpg", stderr: "", exitCode: 0 });
    let requested = "";
    dl.mockImplementation(async (_s, path) => {
      requested = path;
      return asResponse(Buffer.alloc(500 * 1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "IMG_0001.heic", type: "image/heic" },
    ]);
    // The delivered bytes are the converted JPEG copy…
    expect(requested).toMatch(/^\.capka\/native-img\/.+\/0\.jpg$/);
    const parts = fileParts(msgs) as { mediaType: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0].mediaType).toBe("image/jpeg");
    // …while the announced file is still the user's original HEIC path.
    expect(injected).toEqual([{ name: "IMG_0001.heic", type: "image/heic" }]);
  });

  it("DROPS a non-native image whose re-encode failed (routes it to tools, not the provider)", async () => {
    // HEIC that fails to convert can't be sent inline to Anthropic — it must not
    // be injected (a raw HEIC would 400) nor announced as delivered.
    exec.mockResolvedValue({ stdout: "__ERR__", stderr: "convert: boom", exitCode: 0 });
    const seen: string[] = [];
    dl.mockImplementation(async (_s, path) => {
      seen.push(path);
      return asResponse(Buffer.alloc(1024));
    });
    const msgs = userMessages();
    const injected = await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "broken.heic", type: "image/heic" },
    ]);
    expect(injected).toEqual([]);
    expect(fileParts(msgs)).toHaveLength(0);
    expect(seen).toEqual([]); // nothing downloaded
  });

  it("keeps the original when the image is already fine (__KEEP__)", async () => {
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

  it("falls back to the original when a NATIVE format's re-encode fails", async () => {
    // A WebP that fails to normalize is still deliverable as-is → keep it.
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

  it("places attachment parts BEFORE the user's text", async () => {
    exec.mockResolvedValue({ stdout: "__KEEP__", stderr: "", exitCode: 0 });
    dl.mockResolvedValue(asResponse(Buffer.alloc(1024)));
    const msgs = userMessages("what is this?");
    await injectNativeFiles(msgs, "sess", "u1", "anthropic", [
      { name: "photo.jpg", type: "image/jpeg" },
    ]);
    // File first, user's text last — the image-then-text structure providers prefer.
    expect(partTypes(msgs)).toEqual(["file", "text"]);
  });
});
