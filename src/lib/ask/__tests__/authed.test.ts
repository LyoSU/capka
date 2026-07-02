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
    update: () => ({ set: (v: unknown) => ({ where: () => { rows.updated = v; } }) }),
  },
}));

import { answerAskForUser } from "../authed";

describe("answerAskForUser", () => {
  beforeEach(() => { enqueueTask.mockClear(); rows.updated = undefined; });

  it("writes the answer + tool-result and enqueues a resume for an ask suspend", async () => {
    rows.msg = {
      chatId: "chat1", ownerId: "u1", projectId: null,
      metadata: { taskId: "t1", status: "awaiting_answer", parts: [
        { type: "tool-call", id: "c1", name: "ask", input: {}, answer: { form: { fields: [{ id: "q", label: "Q?", kind: "text" }] } } },
      ] },
    };
    rows.task = { payload: { requestModel: "m", origin: undefined } };
    const ok = await answerAskForUser("u1", { messageId: "m1", action: "submit", values: { q: "Kyiv" } });
    expect(ok).toBe(true);
    expect(enqueueTask).toHaveBeenCalledOnce();
    expect(enqueueTask.mock.calls[0][0].payload.resumeMessageId).toBe("m1");
    // The tool-result was appended so the resume sees a complete call→result pair.
    const parts = (rows.updated as { metadata: { parts: { type: string }[] } }).metadata.parts;
    expect(parts.some((p) => p.type === "tool-result")).toBe(true);
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
