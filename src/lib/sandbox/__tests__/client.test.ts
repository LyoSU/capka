import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logged }));

import { downloadFile, listFiles } from "../client";

beforeEach(() => { for (const fn of Object.values(logged)) fn.mockReset(); });
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

describe("what a failed sandbox call writes to the operator's log", () => {
  // The line that sent me hunting a download regression on the demo host. Six
  // "sandbox download failed" errors, no file, no session, no status — and the
  // cause was an agent mentioning a /workspace path that was never a file.
  it("reports a missing file as a warning, with enough context to place it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "File not found" }), { status: 404 }),
    );

    await expect(downloadFile("chat1", "notes/gone.html", "user1")).rejects.toMatchObject({ status: 404 });

    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.warn).toHaveBeenCalledWith("sandbox download failed", expect.objectContaining({
      sessionId: "chat1", path: "notes/gone.html", status: 404,
    }));
  });

  it("still reports a real controller failure as an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(downloadFile("chat1", "f.html", "user1")).rejects.toMatchObject({ status: 502 });
    expect(logged.error).toHaveBeenCalledWith("sandbox download failed", expect.objectContaining({ status: 500 }));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  // request()'s own doc says the raw path is NEVER recorded because its query
  // carries a workspaceToken — an HMAC that authorizes access to that workspace.
  // It was being recorded, so a failed listing left a live credential in the log.
  it("never writes the workspace token into the log", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session not found" }), { status: 404 }),
    );

    await expect(listFiles("chat1", ".", "user1")).rejects.toBeTruthy();

    const fields = logged.warn.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.path).toBe("/sessions/{id}/files");
    expect(JSON.stringify(fields)).not.toContain("token");
  });

  // The level is one rule for the whole file, not a judgement per call site: a
  // listing of a path that isn't there is the caller's business, a 500 is the
  // deployment's. Asserted on `request()` as well as on the download path, because
  // a rule that holds at one site and not its neighbours reads as an exception.
  it("picks the level from the status on the shared request path too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session not found" }), { status: 404 }),
    );
    await expect(listFiles("chat1", ".", "user1")).rejects.toBeTruthy();
    expect(logged.warn).toHaveBeenCalledWith("sandbox request failed", expect.objectContaining({ status: 404 }));
    expect(logged.error).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    logged.warn.mockReset();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    await expect(listFiles("chat1", ".", "user1")).rejects.toBeTruthy();
    expect(logged.error).toHaveBeenCalledWith("sandbox request failed", expect.objectContaining({ status: 500 }));
    expect(logged.warn).not.toHaveBeenCalled();
  });
});
