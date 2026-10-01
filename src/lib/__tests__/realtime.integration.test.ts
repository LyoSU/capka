import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { realtime } from "../realtime";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run realtime.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;
const unit = process.env.RUN_INTEGRATION ? describe.skip : describe;

// Count every pg Client opened, so the C6 test can assert single-flight. Hoisted
// so it applies to the statically-imported realtime singleton too — keeping this
// a pure unit test (no live DB).
const opened = vi.hoisted(() => ({ count: 0, clients: [] as FakeClient[] }));
type FakeClient = {
  queries: string[];
  hang: boolean;
  ended: boolean;
  emit: (event: string, ...args: unknown[]) => void;
};
// vi.mock is hoisted to the top of the module regardless of where it sits, so the
// stub-vs-real choice has to live INSIDE the factory: the opt-in integration block
// needs the real pg (live LISTEN/NOTIFY), the unit test below needs the stub.
vi.mock("pg", async (importOriginal) => {
  if (process.env.RUN_INTEGRATION) return importOriginal();
  return {
    // db/index.ts opens a Pool at import; a no-op stand-in keeps it lazy.
    Pool: class {},
    // It also pins pg's date encoding to UTC at import — see db/index.ts.
    defaults: {},
    types: { builtins: { TIMESTAMP: 1114 }, setTypeParser: () => {} },
    // Keeps its handlers and records every query, so a test can watch what the
    // code sends and break the connection the way a real one breaks.
    Client: class {
      queries: string[] = [];
      hang = false;
      ended = false;
      private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
      constructor() {
        opened.count++;
        opened.clients.push(this);
      }
      on(event: string, fn: (...args: unknown[]) => void) {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      }
      emit(event: string, ...args: unknown[]) {
        for (const fn of this.handlers.get(event) ?? []) fn(...args);
      }
      async connect() {
        // A real connect isn't instant; the await lets a second concurrent
        // publish reach the guard and (correctly) reuse the in-flight connect.
        await new Promise((r) => setTimeout(r, 10));
      }
      query(text: string) {
        this.queries.push(text);
        // A half-open socket: the query is written and nothing ever comes back.
        return this.hang ? new Promise(() => {}) : Promise.resolve();
      }
      async end() {
        this.ended = true;
        this.emit("end");
      }
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

unit("realtime LISTEN heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces a LISTEN connection that stops answering and re-LISTENs on the new one", async () => {
    vi.useFakeTimers();
    opened.clients.length = 0;
    const received: unknown[] = [];
    const subscribing = realtime.subscribe("user:hb", (d) => received.push(d));
    await vi.advanceTimersByTimeAsync(10);
    const unsub = await subscribing;
    const [first] = opened.clients;
    // Once: the connect LISTENs every registered channel, so subscribe adds none.
    expect(first.queries).toEqual(['LISTEN "ch_user_hb"']);

    // A healthy connection answers every ping and is kept.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.queries.filter((q) => q === "SELECT 1")).toHaveLength(2);
    expect(opened.clients).toHaveLength(1);

    // It goes half-open: no error, no end, just silence.
    first.hang = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.ended).toBe(true);
    // Reconnect backoff (1s) plus the connect.
    await vi.advanceTimersByTimeAsync(1_010);
    expect(opened.clients).toHaveLength(2);
    const second = opened.clients[1];
    expect(second.queries).toEqual(['LISTEN "ch_user_hb"']);

    // Events reach the subscriber over the new connection; the dead one is no
    // longer pinged.
    second.emit("notification", { channel: "ch_user_hb", payload: '{"n":1}' });
    expect(received).toEqual([{ n: 1 }]);
    const pings = first.queries.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.queries).toHaveLength(pings);
    expect(second.queries.filter((q) => q === "SELECT 1")).toHaveLength(2);
    unsub();
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
