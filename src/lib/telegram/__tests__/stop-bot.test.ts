import { describe, it, expect, vi, beforeEach } from "vitest";

// stopBot() used to return with pieces still sitting in the burst collector, so a
// restart inside the burst window dropped an already-received Telegram message
// with no task, no reply and no error. The collector is the only place those
// pieces exist, so the shutdown path has to flush it — this pins the wiring, not
// the collector (see burst.test.ts for the flush itself).
const { drainAll } = vi.hoisted(() => ({ drainAll: vi.fn(async () => {}) }));
vi.mock("@/lib/telegram/burst", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/burst")>();
  return {
    ...actual,
    createBurstCollector: () => ({ add: vi.fn(), drain: vi.fn(async () => {}), drainAll }),
  };
});

// bot.ts pulls the whole platform in at module scope; none of it is exercised by
// stopBot() with no bot built, so stub the modules that would open a socket.
vi.mock("@/lib/db", () => ({ db: {}, pool: { connect: vi.fn() } }));
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}) }));

import { stopBot } from "../bot";

beforeEach(() => drainAll.mockClear());

describe("stopBot", () => {
  it("flushes every open burst before returning", async () => {
    await stopBot();
    expect(drainAll).toHaveBeenCalledTimes(1);
  });

  it("still returns when the flush itself fails (a stuck shutdown is worse)", async () => {
    drainAll.mockRejectedValueOnce(new Error("ingest exploded"));
    await expect(stopBot()).resolves.toBeUndefined();
    expect(drainAll).toHaveBeenCalledTimes(1);
  });
});
