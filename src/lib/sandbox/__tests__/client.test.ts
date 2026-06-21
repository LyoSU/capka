import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadFile } from "../client";

afterEach(() => vi.restoreAllMocks());

describe("downloadFile error mapping", () => {
  it("surfaces a missing file (controller 404) as a 404, not a 502 gateway error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 }),
    );

    await expect(downloadFile("chat1", "gone.html", "user1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps a real controller failure (5xx) as a 502 gateway error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(downloadFile("chat1", "f.html", "user1")).rejects.toMatchObject({
      status: 502,
    });
  });
});
