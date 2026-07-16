import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdown, installShutdownHandlers } from "./shutdown.js";

function fakeServer() {
  return {
    listening: true,
    close: vi.fn((done) => { queueMicrotask(() => done()); }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  };
}

describe("controller graceful shutdown", () => {
  it("drains HTTP, flushes activity, closes Postgres, and exits cleanly", async () => {
    const server = fakeServer();
    const store = { flush: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const markNotReady = vi.fn();
    const stopMaintenance = vi.fn();
    const log = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ server, store, pool, markNotReady, stopMaintenance, log, exit });

    await shutdown("SIGTERM");

    expect(markNotReady).toHaveBeenCalledOnce();
    expect(stopMaintenance).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(store.flush).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent when the orchestrator repeats a signal", async () => {
    const server = fakeServer();
    const store = { flush: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      server, store, pool, markNotReady: vi.fn(), stopMaintenance: vi.fn(), log: vi.fn(), exit,
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(server.close).toHaveBeenCalledOnce();
    expect(store.flush).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("still closes Postgres and exits non-zero when the final flush fails", async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const log = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      server: fakeServer(),
      store: { flush: vi.fn().mockRejectedValue(new Error("database unavailable")) },
      pool,
      markNotReady: vi.fn(),
      stopMaintenance: vi.fn(),
      log,
      exit,
    });

    await shutdown("SIGTERM");

    expect(pool.end).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "shutdown.error",
      expect.objectContaining({ phase: "flush", err: "database unavailable" }),
      "warn",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("forces stuck HTTP connections closed after the grace window, then flushes", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      server.close.mockImplementation(() => {}); // simulate a request that never drains
      const store = { flush: vi.fn().mockResolvedValue(undefined) };
      const log = vi.fn();
      const exit = vi.fn();
      const shutdown = createGracefulShutdown({
        server,
        store,
        pool: { end: vi.fn().mockResolvedValue(undefined) },
        markNotReady: vi.fn(),
        stopMaintenance: vi.fn(),
        log,
        exit,
        timeoutMs: 50,
      });

      const done = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(50);
      await done;

      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      expect(store.flush).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("shutdown.http_forced", { signal: "SIGTERM", timeoutMs: 50 }, "warn");
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both signal handlers idempotent until explicitly removed", () => {
    const proc = new EventEmitter();
    const shutdown = vi.fn();
    const remove = installShutdownHandlers(shutdown, proc);

    proc.emit("SIGTERM");
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    expect(shutdown.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGTERM", "SIGINT"]);

    remove();
    proc.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(3);
  });
});
