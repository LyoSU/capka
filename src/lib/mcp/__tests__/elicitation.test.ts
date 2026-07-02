import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { answer: unknown } = { answer: null };
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ answer: state.answer }] }) }) }),
    delete: () => ({ where: async () => {} }),
  },
}));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent: async () => {} }));

import { makeElicitHandler } from "../elicitation";

describe("makeElicitHandler", () => {
  beforeEach(() => { state.answer = null; });

  it("resolves to accept with content when the row is answered", async () => {
    state.answer = { action: "submit", values: { name: "x" } };
    const handler = makeElicitHandler({ userId: "u1", chatId: "c1", messageId: "m1", timeoutMs: 2000 });
    const res = await handler({ params: { message: "hi", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } });
    expect(res).toEqual({ action: "accept", content: { name: "x" } });
  });

  it("cancels on timeout when never answered", async () => {
    const handler = makeElicitHandler({ userId: "u1", chatId: "c1", messageId: "m1", timeoutMs: 50 });
    const res = await handler({ params: { message: "hi", requestedSchema: { type: "object", properties: {} } } });
    expect(res).toEqual({ action: "cancel" });
  });
});
