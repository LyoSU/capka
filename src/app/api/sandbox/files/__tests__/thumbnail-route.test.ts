import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession: vi.fn(async () => ({ userId: "u1", role: "user" })) };
});
vi.mock("@/lib/db/ownership", () => ({
  requireOwned: vi.fn(async () => ({ id: "c1", projectId: null })),
}));
const sandbox = vi.hoisted(() => ({ listFiles: vi.fn(), execCommand: vi.fn() }));
vi.mock("@/lib/sandbox/client", () => sandbox);

import { GET } from "@/app/api/sandbox/files/thumbnail/route";

const get = (path: string) => GET(new Request(`http://x/api/sandbox/files/thumbnail?chatId=c1&path=${encodeURIComponent(path)}`));

beforeEach(() => vi.clearAllMocks());

describe("thumbnail route", () => {
  it("answers an empty 204, not a 404, when no sandbox is running to draw the page", async () => {
    // The file is in the workspace (a just-attached file in a new chat); only the
    // renderer is missing. A 404 made the browser log an error for every tile.
    sandbox.listFiles.mockResolvedValue({ entries: [{ path: "./report.pdf", isDirectory: false, modifiedAt: "2026-10-02T10:00:00.000Z", size: 10 }] });
    sandbox.execCommand.mockRejectedValue(new Error("no container"));
    const res = await get("report.pdf");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers 204 for a format it does not draw, without asking the sandbox", async () => {
    const res = await get("notes.txt");
    expect(res.status).toBe(204);
    expect(sandbox.listFiles).not.toHaveBeenCalled();
  });

  it("serves the PNG the sandbox rendered", async () => {
    sandbox.listFiles.mockResolvedValue({ entries: [{ path: "./a.docx", isDirectory: false, modifiedAt: "2026-10-02T10:00:00.000Z", size: 11 }] });
    sandbox.execCommand.mockResolvedValue({ stdout: Buffer.from("PNGDATA").toString("base64"), stderr: "", exitCode: 0 });
    const res = await get("a.docx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PNGDATA");
  });
});
