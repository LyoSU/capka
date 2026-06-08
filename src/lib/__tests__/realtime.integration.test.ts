import { describe, it, expect } from "vitest";
import { realtime } from "../realtime";

// Opt-in: RUN_INTEGRATION=1 DATABASE_URL=... npx vitest run realtime.integration
const run = process.env.RUN_INTEGRATION ? describe : describe.skip;

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
