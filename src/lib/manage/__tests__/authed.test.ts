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
    // approveManageForUser guards the write and reads its rowCount via
    // `.set().where().returning()` — `updateReturn` is what the conditional matched.
    update: () => ({
      set: (v: unknown) => { rows.updated = v; return { where: () => ({ returning: () => rows.updateReturn ?? [] }) }; },
    }),
  },
}));

import { approveManageForUser } from "../authed";

const pendingApproval = () => ({
  chatId: "chat1", ownerId: "u1", projectId: null,
  metadata: { taskId: "t1", status: "awaiting_approval", parts: [
    { type: "tool-call", id: "c1", name: "manage", input: {}, approval: { id: "ap1" } }, // no `approved` yet
  ] },
});

describe("approveManageForUser — atomic single-use approval", () => {
  beforeEach(() => { enqueueTask.mockClear(); rows.updated = undefined; rows.updateReturn = undefined; });

  it("records the decision and enqueues a resume when the guarded update matches", async () => {
    rows.msg = pendingApproval();
    rows.task = { payload: { requestModel: "m", origin: undefined } };
    rows.updateReturn = [{ id: "m1" }]; // this caller won the transition
    const ok = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(ok).toBe(true);
    expect(enqueueTask).toHaveBeenCalledOnce();
    expect(enqueueTask.mock.calls[0][0].payload.resumeMessageId).toBe("m1");
    const parts = (rows.updated as { metadata: { parts: { approval?: { approved?: boolean } }[] } }).metadata.parts;
    expect(parts[0].approval?.approved).toBe(true);
  });

  it("is single-use: a racing second decision (guarded update matches 0 rows) does NOT enqueue a duplicate resume", async () => {
    rows.msg = pendingApproval(); // still looks undecided in this caller's read…
    rows.task = { payload: {} };
    rows.updateReturn = []; // …but the conditional update matched nothing — already decided
    const ok = await approveManageForUser("u1", { messageId: "m1", approved: false });
    expect(ok).toBe(false);
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it("returns false when the message isn't the caller's (no write, no resume)", async () => {
    rows.msg = { chatId: "chat1", ownerId: "someone-else", projectId: null, metadata: { parts: [] } };
    const ok = await approveManageForUser("u1", { messageId: "m1", approved: true });
    expect(ok).toBe(false);
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
