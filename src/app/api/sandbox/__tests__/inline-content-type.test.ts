import { describe, it, expect, vi } from "vitest";

/**
 * "Open in a new tab" has to open, not download.
 *
 * A browser handed `application/octet-stream` under `X-Content-Type-Options:
 * nosniff` saves the file, whatever the Content-Disposition says — so an inline
 * request for a .md or a .csv used to behave exactly like the Download button
 * beside it. The fix is the response header, which is why the assertions here are
 * on real responses from the handler rather than on a helper.
 *
 * The other half is the security posture the widening must not cost: a file whose
 * bytes look like HTML still goes out as text/plain, and `nosniff` is what stops
 * the browser reading it back as markup.
 */
const { requireSession, downloadFile, downloadSharedFile, resolveWorkspaceTarget } = vi.hoisted(() => ({
  requireSession: vi.fn(() => Promise.resolve({ userId: "u1" })),
  downloadFile: vi.fn(),
  downloadSharedFile: vi.fn(),
  resolveWorkspaceTarget: vi.fn(() => Promise.resolve({ sessionKey: "chat:c1" })),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession };
});
vi.mock("@/lib/sandbox/client", () => ({ downloadFile, downloadSharedFile }));
vi.mock("@/lib/sandbox/target", () => ({
  resolveWorkspaceTarget,
  targetParamsFrom: () => ({ chatId: "c1" }),
}));

import { GET as DOWNLOAD } from "@/app/api/sandbox/files/download/route";
import { GET as SHARED } from "@/app/api/sandbox/shared/download/route";

// The controller labels everything octet-stream; the route is what narrows it.
const controllerSays = () => new Response("body", { headers: { "Content-Type": "application/octet-stream" } });

const inlineType = async (name: string) => {
  downloadFile.mockResolvedValue(controllerSays());
  const res = await DOWNLOAD(new Request(`http://x/api/sandbox/files/download?chatId=c1&inline=1&path=${encodeURIComponent(name)}`));
  return res.headers.get("Content-Type");
};

describe("inline downloads are labelled so the browser shows them", () => {
  it("text and markdown go out as text/plain, which is what makes the tab render", async () => {
    for (const name of ["notes.md", "data.csv", "server.log", "config.json", "main.py", "readme.txt"]) {
      expect(await inlineType(name), name).toBe("text/plain; charset=utf-8");
    }
  });

  it("images and PDFs keep their own type, as before", async () => {
    expect(await inlineType("chart.png")).toBe("image/png");
    expect(await inlineType("report.pdf")).toBe("application/pdf");
  });

  it("a real binary stays octet-stream — the browser is right to save those", async () => {
    for (const name of ["book.xlsx", "archive.zip", "clip.mp4"]) {
      expect(await inlineType(name), name).toBe("application/octet-stream");
    }
  });

  it("HTML is never labelled text/html — the whole point of narrowing the type", async () => {
    for (const name of ["page.html", "page.htm", "doc.xhtml"]) {
      expect(await inlineType(name), name).not.toMatch(/html/);
    }
  });

  it("the widened types keep nosniff and the locked-down CSP", async () => {
    downloadFile.mockResolvedValue(controllerSays());
    const res = await DOWNLOAD(new Request("http://x/api/sandbox/files/download?chatId=c1&inline=1&path=notes.md"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
  });

  it("without inline nothing changes: a text file is still an attachment", async () => {
    downloadFile.mockResolvedValue(controllerSays());
    const res = await DOWNLOAD(new Request("http://x/api/sandbox/files/download?chatId=c1&path=notes.md"));
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("the shared store answers the same way — same bytes, same provenance", async () => {
    downloadSharedFile.mockResolvedValue(controllerSays());
    const res = await SHARED(new Request("http://x/api/sandbox/shared/download?inline=1&path=notes.md"));
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
