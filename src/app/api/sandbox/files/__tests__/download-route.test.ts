import { describe, it, expect, vi } from "vitest";

// Keep apiHandler real (so the Response passes through), stub only the auth gate.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireSession: vi.fn(async () => ({ userId: "u1" })) };
});
vi.mock("@/lib/db/ownership", () => ({
  requireOwned: vi.fn(async () => ({ id: "c1", projectId: null })),
}));
vi.mock("@/lib/sandbox/client", () => ({
  // The controller streams the file body chunked, WITHOUT a Content-Length header
  // (the isolated-compute controller does this — transfer-encoding: chunked).
  downloadFile: vi.fn(async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello world"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/plain" } });
  }),
}));

import { GET } from "@/app/api/sandbox/files/download/route";

describe("sandbox download route — header proxying", () => {
  it("never emits an empty Content-Length when the controller streams without one", async () => {
    const req = new Request(
      "http://x/api/sandbox/files/download?chatId=c1&path=f.txt&inline=1",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    // An empty Content-Length is invalid HTTP — the upstream proxy rejects the
    // origin response and returns 502 Bad gateway.
    expect(res.headers.get("Content-Length")).not.toBe("");
  });
});
