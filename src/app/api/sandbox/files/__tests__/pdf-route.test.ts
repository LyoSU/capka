import { describe, it, expect, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({ role: "user" as "user" | "admin" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession: vi.fn(async () => ({ userId: "u1", role: session.role })) };
});
vi.mock("@/lib/db/ownership", () => ({
  requireOwned: vi.fn(async () => ({ id: "c1", projectId: null })),
}));
const sandbox = vi.hoisted(() => ({
  listFiles: vi.fn(),
  execCommand: vi.fn(),
}));
vi.mock("@/lib/sandbox/client", () => sandbox);

import { GET } from "@/app/api/sandbox/files/pdf/route";
import { PDF_CHUNK_BYTES, PDF_CHUNK_SCRIPT, THUMBNAIL_SCRIPT } from "@/lib/sandbox/thumbnail";

// Each test uses its own file version (size) so the route's in-memory failure
// cache from one test cannot answer for the next.
let size = 1000;
function listing(name = "report.docx") {
  size += 1;
  sandbox.listFiles.mockResolvedValue({ entries: [{ path: `./${name}`, isDirectory: false, modifiedAt: "2026-10-02T10:00:00.000Z", size }] });
}
const get = (path: string, headers?: Record<string, string>) =>
  GET(new Request(`http://x/api/sandbox/files/pdf?chatId=c1&path=${encodeURIComponent(path)}`, { headers }));

/** A fake sandbox holding `pdf` as the converted file: answers the conversion
 *  with its size and each chunk read with that slice, base64. */
function sandboxWith(pdf: Buffer, convert = { exitCode: 0 }) {
  sandbox.execCommand.mockImplementation(async (_s: string, script: string, _t: number, _sig: unknown, env: Record<string, string>) => {
    if (script === THUMBNAIL_SCRIPT) {
      expect(env.CAPKA_THUMB_FORMAT).toBe("pdf");
      return convert.exitCode === 0 ? { stdout: `${pdf.length}\n`, stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: convert.exitCode };
    }
    expect(script).toBe(PDF_CHUNK_SCRIPT);
    const i = Number(env.CAPKA_PDF_CHUNK);
    return { stdout: pdf.subarray(i * PDF_CHUNK_BYTES, (i + 1) * PDF_CHUNK_BYTES).toString("base64"), stderr: "", exitCode: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "user";
});

describe("document preview route", () => {
  it("serves the converted PDF, read out of the sandbox in chunks", async () => {
    listing();
    const pdf = Buffer.alloc(PDF_CHUNK_BYTES * 2 + 123, 7);
    pdf.write("%PDF-1.7");
    sandboxWith(pdf);
    const res = await get("report.docx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);
    // One conversion, then three slices.
    expect(sandbox.execCommand).toHaveBeenCalledTimes(4);
  });

  it("answers a revalidation with 304 without touching the sandbox", async () => {
    listing();
    sandboxWith(Buffer.from("%PDF"));
    const etag = (await get("report.docx")).headers.get("ETag")!;
    sandbox.execCommand.mockClear();
    const res = await get("report.docx", { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(sandbox.execCommand).not.toHaveBeenCalled();
  });

  it("runs one conversion for two viewers opening the same document at once", async () => {
    listing();
    sandboxWith(Buffer.from("%PDF-small"));
    const [a, b] = await Promise.all([get("report.docx"), get("report.docx")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const conversions = sandbox.execCommand.mock.calls.filter((c) => c[1] === THUMBNAIL_SCRIPT);
    expect(conversions).toHaveLength(1);
  });

  it("refuses formats it does not convert, and paths that leave the workspace", async () => {
    for (const p of ["sheet.xlsx", "doc.pdf", "notes.txt", "../x.docx", "/etc/x.docx"]) {
      expect((await get(p)).status).toBe(404);
    }
    expect(sandbox.listFiles).not.toHaveBeenCalled();
  });

  it("is 404 for a document that is not in the workspace", async () => {
    sandbox.listFiles.mockResolvedValue({ entries: [] });
    expect((await get("gone.docx")).status).toBe(404);
    expect(sandbox.execCommand).not.toHaveBeenCalled();
  });

  it("is 503 when no sandbox is running, and never starts one", async () => {
    listing();
    sandbox.execCommand.mockRejectedValue(new Error("no container"));
    const res = await get("report.docx");
    expect(res.status).toBe(503);
  });

  it("tells an admin why a conversion failed, and nobody else", async () => {
    listing();
    sandboxWith(Buffer.alloc(0), { exitCode: 8 });
    const user = await get("report.docx");
    expect(user.status).toBe(422);
    expect(await user.json()).toEqual({ error: "No preview" });

    session.role = "admin";
    const admin = await get("report.docx");
    expect(admin.status).toBe(422);
    expect((await admin.json()).reason).toMatch(/LibreOffice/);
    // The failure is remembered for this file version: no second LibreOffice run.
    expect(sandbox.execCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses a converted PDF over the preview limit without reading it out", async () => {
    listing("deck.pptx");
    sandbox.execCommand.mockResolvedValue({ stdout: String(25 * 1024 * 1024), stderr: "", exitCode: 0 });
    const res = await get("deck.pptx");
    expect(res.status).toBe(413);
    expect(sandbox.execCommand).toHaveBeenCalledTimes(1);
  });
});
