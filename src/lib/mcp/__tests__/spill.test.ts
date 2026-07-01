import { describe, it, expect, vi, beforeEach } from "vitest";
import { spillToWorkspace } from "../spill";
import { uploadFile } from "@/lib/sandbox/client";

vi.mock("@/lib/sandbox/client", () => ({ uploadFile: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const mockedUpload = vi.mocked(uploadFile);

describe("spillToWorkspace", () => {
  beforeEach(() => {
    mockedUpload.mockReset();
    mockedUpload.mockResolvedValue({ ok: true, path: "x", name: "x" });
  });

  it("returns null without a session key (nowhere to park)", async () => {
    expect(await spillToWorkspace(undefined, "u1", { bytes: Buffer.from("hi") })).toBeNull();
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it("writes to .capka/output/mcp and returns the workspace path", async () => {
    const path = await spillToWorkspace("sess", "u1", { bytes: Buffer.from("data"), mimeType: "image/png" });
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    const [sessionKey, dir, file, userId] = mockedUpload.mock.calls[0];
    expect(sessionKey).toBe("sess");
    expect(dir).toBe(".capka/output/mcp");
    expect(userId).toBe("u1");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toMatch(/^\d+-[a-z0-9]+\.png$/);
    expect(path).toBe(`/workspace/.capka/output/mcp/${(file as File).name}`);
  });

  it("picks the extension from the mimeType allowlist, never from server data", async () => {
    await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x"), mimeType: "application/pdf" });
    expect((mockedUpload.mock.calls[0][2] as File).name).toMatch(/\.pdf$/);
  });

  it("falls back to .txt for any text/* and .bin for an unknown mimeType", async () => {
    await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x"), mimeType: "text/x-python" });
    expect((mockedUpload.mock.calls[0][2] as File).name).toMatch(/\.txt$/);
    mockedUpload.mockClear();
    await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x"), mimeType: "application/x-evil" });
    expect((mockedUpload.mock.calls[0][2] as File).name).toMatch(/\.bin$/);
    mockedUpload.mockClear();
    await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x") });
    expect((mockedUpload.mock.calls[0][2] as File).name).toMatch(/\.bin$/);
  });

  it("ignores a crafted mimeType that tries to smuggle a path/extension", async () => {
    await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x"), mimeType: "../../etc/passwd" });
    // Unknown → .bin, and the name has no path separators.
    const name = (mockedUpload.mock.calls[0][2] as File).name;
    expect(name).toMatch(/^\d+-[a-z0-9]+\.bin$/);
    expect(name).not.toContain("/");
  });

  it("returns null (never throws) when the upload fails — e.g. quota 413", async () => {
    mockedUpload.mockRejectedValue(new Error("Workspace quota exceeded"));
    expect(await spillToWorkspace("sess", "u1", { bytes: Buffer.from("x") })).toBeNull();
  });
});
