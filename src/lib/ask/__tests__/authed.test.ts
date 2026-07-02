import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueTask = vi.fn();
vi.mock("@/lib/tasks/queue", () => ({ enqueueTask: (...a: unknown[]) => enqueueTask(...a) }));

const rows: Record<string, unknown> = {};
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => [rows.msg] }) }),
        where: () => ({ limit: () => [rows.task] }),
      }),
    }),
    // Both answerAskForUser and answerElicitationForUser now guard the write and read
    // its rowCount via `.set().where().returning()` — `updateReturn` is the rows the
    // guarded update matched (empty = the pending item was already resolved).
    update: () => ({
      set: (v: unknown) => { rows.updated = v; return { where: () => ({ returning: () => rows.updateReturn ?? [] }) }; },
    }),
  },
}));

import { answerAskForUser, answerElicitationForUser } from "../authed";

describe("answerAskForUser", () => {
  beforeEach(() => { enqueueTask.mockClear(); rows.updated = undefined; rows.updateReturn = undefined; });

  const pendingAsk = () => ({
    chatId: "chat1", ownerId: "u1", projectId: null,
    metadata: { taskId: "t1", status: "awaiting_answer", parts: [
      { type: "tool-call", id: "c1", name: "ask", input: {}, answer: { form: { fields: [{ id: "q", label: "Q?", kind: "text" }] } } },
    ] },
  });

  it("writes the answer + tool-result and enqueues a resume for an ask suspend", async () => {
    rows.msg = pendingAsk();
    rows.task = { payload: { requestModel: "m", origin: undefined } };
    rows.updateReturn = [{ id: "m1" }]; // the guarded update matched — this caller won
    const ok = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } });
    expect(ok).toBe(true);
    expect(enqueueTask).toHaveBeenCalledOnce();
    expect(enqueueTask.mock.calls[0][0].payload.resumeMessageId).toBe("m1");
    // The tool-result was appended so the resume sees a complete call→result pair.
    const parts = (rows.updated as { metadata: { parts: { type: string }[] } }).metadata.parts;
    expect(parts.some((p) => p.type === "tool-result")).toBe(true);
  });

  it("is single-use: a racing second answer whose guarded update matches 0 rows does NOT enqueue a duplicate resume", async () => {
    rows.msg = pendingAsk(); // still looks pending in this caller's read…
    rows.task = { payload: {} };
    rows.updateReturn = []; // …but the conditional update matched nothing — someone already answered
    const ok = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "late" } });
    expect(ok).toBe(false);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("returns false when the message isn't the caller's", async () => {
    rows.msg = { chatId: "chat1", ownerId: "someone-else", metadata: { parts: [] } };
    const ok = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(ok).toBe(false);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("returns false when there is no pending ask call", async () => {
    rows.msg = { chatId: "chat1", ownerId: "u1", projectId: null, metadata: { parts: [{ type: "text", text: "hi" }] } };
    const ok = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(ok).toBe(false);
  });
});

describe("answerElicitationForUser", () => {
  beforeEach(() => { rows.updated = undefined; rows.updateReturn = undefined; });

  it("writes the answer onto the pending_elicitation row", async () => {
    rows.updateReturn = [{ id: "e1" }];
    const ok = await answerElicitationForUser("u1", { messageId: "m1", action: "submit", values: { name: "x" } });
    expect(ok).toBe(true);
    expect((rows.updated as { answer?: unknown }).answer).toEqual({ action: "submit", values: { name: "x" } });
  });

  it("returns false when no matching pending row (already answered / not owner)", async () => {
    rows.updateReturn = [];
    const ok = await answerElicitationForUser("u1", { messageId: "m1", action: "submit", values: {} });
    expect(ok).toBe(false);
  });
});
