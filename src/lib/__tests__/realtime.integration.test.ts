import { describe, it, expect, vi, beforeEach } from "vitest";
import { realtime } from "../realtime";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run realtime.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const unit = process.env.RUN_INTEGRATION ? describe.skip : describe;

// Count every pg Client opened, so the C6 test can assert single-flight. Hoisted
// so it applies to the statically-imported realtime singleton too — keeping this
// a pure unit test (no live DB).
const opened = vi.hoisted(() => ({ count: 0 }));
// vi.mock is hoisted to the top of the module regardless of where it sits, so the
// stub-vs-real choice has to live INSIDE the factory: the opt-in integration block
// needs the real pg (live LISTEN/NOTIFY), the unit test below needs the stub.
vi.mock("pg", async (importOriginal) => {
  if (process.env.RUN_INTEGRATION) return importOriginal();
  return {
    // db/index.ts opens a Pool at import; a no-op stand-in keeps it lazy.
    Pool: class {},
    Client: class {
      constructor() {
        opened.count++;
      }
      on() {}
      async connect() {
        // A real connect isn't instant; the await lets a second concurrent
        // publish reach the guard and (correctly) reuse the in-flight connect.
        await new Promise((r) => setTimeout(r, 10));
      }
      async query() {}
    },
  };
});

// C6 regression: two concurrent publishes when pub === null must open exactly
// one Client (the single-flight guard), never leak a clobbered second one.
unit("realtime.publish connection single-flight (C6)", () => {
  beforeEach(() => {
    opened.count = 0;
  });

  it("opens exactly one client under concurrent publishes", async () => {
    await Promise.all([
      realtime.publish("user:race", { n: 1 }),
      realtime.publish("user:race", { n: 2 }),
      realtime.publish("user:race", { n: 3 }),
    ]);
    expect(opened.count).toBe(1);
    // A subsequent publish reuses the same connected client.
    await realtime.publish("user:race", { n: 4 });
    expect(opened.count).toBe(1);
  });
});

run("realtime LISTEN/NOTIFY round-trip", () => {
  it("delivers a published event to a subscriber", async () => {
    const received: unknown[] = [];
    const unsub = await realtime.subscribe("user:test-123", (d) => received.push(d));

    await realtime.publish("user:test-123", { type: "ping", n: 1 });
    // Give NOTIFY a moment to round-trip through Postgres.
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toEqual([{ type: "ping", n: 1 }]);
    unsub();
  }, 20_000);

  it("delivers to a MIXED-CASE channel (regression: LISTEN must not lowercase it)", async () => {
    // Real user IDs (nanoid/better-auth) contain uppercase. An unquoted
    // `LISTEN ident` folds to lowercase while pg_notify keeps the exact case,
    // so without identifier quoting nothing would ever arrive.
    const received: unknown[] = [];
    const unsub = await realtime.subscribe("user:AbC123XyZ", (d) => received.push(d));

    await realtime.publish("user:AbC123XyZ", { type: "ping", n: 2 });
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toEqual([{ type: "ping", n: 2 }]);
    unsub();
  }, 20_000);

  it("collapses oversized payloads into a refresh marker", async () => {
    const received: Array<Record<string, unknown>> = [];
    const unsub = await realtime.subscribe("user:test-big", (d) => received.push(d as Record<string, unknown>));

    await realtime.publish("user:test-big", { type: "text-delta", chatId: "c1", blob: "x".repeat(9000) });
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0]._truncated).toBe(true);
    expect(received[0].chatId).toBe("c1");
    unsub();
  }, 20_000);
});
