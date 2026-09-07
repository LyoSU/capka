import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenError } from "@/lib/errors";

/**
 * "Regenerate title" calls a model, on the shared key when that is how the instance is
 * configured — so it spends. It used to carry neither of the gates `/api/chat` carries:
 * `requireSession` admitted an active `viewer`, and there was no reservation at all, so an
 * owner already over their cap could mint model calls from a menu item indefinitely.
 *
 * What is pinned here is that the SAME two helpers stand in front of the call, and that
 * the reservation this route opens is always closed again — a hold with no task row is
 * reconciled by nothing, so a leaked one inflates the user's budget forever.
 */
const {
  requireWriter, requireOwned, loadActivePath, generateChatTitle,
  resolveAuxTarget, resolveUserModelInfo, reserveBudget, releaseHold,
  recordUsage, publishTaskEvent,
} = vi.hoisted(() => ({
  requireWriter: vi.fn(),
  requireOwned: vi.fn(),
  loadActivePath: vi.fn(),
  generateChatTitle: vi.fn(),
  resolveAuxTarget: vi.fn(),
  resolveUserModelInfo: vi.fn(),
  reserveBudget: vi.fn(),
  releaseHold: vi.fn(),
  recordUsage: vi.fn(),
  publishTaskEvent: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireWriter };
});
vi.mock("@/lib/db/ownership", () => ({ requireOwned }));
vi.mock("@/lib/chat/tree", () => ({ loadActivePath }));
vi.mock("@/lib/chat/title", () => ({ generateChatTitle }));
vi.mock("@/lib/providers/resolve", () => ({ resolveAuxTarget, resolveUserModelInfo }));
vi.mock("@/lib/billing/limits", () => ({ reserveBudget, releaseHold }));
vi.mock("@/lib/usage", () => ({ recordUsage }));
vi.mock("@/lib/tasks/events", () => ({ publishTaskEvent }));

const updates = vi.hoisted(() => ({ set: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        updates.set.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

import { POST } from "@/app/api/chats/[id]/title/route";

const params = Promise.resolve({ id: "c1" });
const post = () => POST(new Request("http://x/api/chats/c1/title", { method: "POST" }), { params });

const TARGET = { model: {}, provider: "openai", modelId: "gpt-x", configId: "cfg1", isShared: true };

beforeEach(() => {
  updates.set = [];
  // A distinct user per test keeps the route's in-memory flood guard out of the way.
  requireWriter.mockReset().mockResolvedValue({ userId: `u-${Math.random()}`, role: "user", status: "active" });
  requireOwned.mockReset().mockResolvedValue({ id: "c1", userId: "u1", model: null, activeLeafId: "m2" });
  loadActivePath.mockReset().mockResolvedValue([
    { node: { role: "user", content: "how do I export this" } },
    { node: { role: "assistant", content: "use File → Export" } },
  ]);
  resolveUserModelInfo.mockReset().mockResolvedValue(TARGET);
  resolveAuxTarget.mockReset().mockResolvedValue(TARGET);
  reserveBudget.mockReset().mockResolvedValue({ allowed: true, window: null, reason: null });
  releaseHold.mockReset().mockResolvedValue(undefined);
  generateChatTitle.mockReset().mockResolvedValue("Exporting a report");
  recordUsage.mockReset().mockResolvedValue(undefined);
  publishTaskEvent.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/chats/[id]/title", () => {
  it("refuses a viewer before a model is called", async () => {
    requireWriter.mockImplementation(() => Promise.reject(new ForbiddenError("Read-only access.")));
    const res = await post();
    expect(res.status).toBe(403);
    expect(generateChatTitle).not.toHaveBeenCalled();
    expect(requireOwned).not.toHaveBeenCalled();
  });

  it("answers the same 429 as a message send when the budget is spent", async () => {
    reserveBudget.mockResolvedValue({ allowed: false, window: "w1", reason: "budget" });
    const res = await post();
    // Same status and code the chat route's BudgetExceededError produces, so the client
    // has one thing to recognise rather than a second shape per surface.
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "BUDGET_EXCEEDED" });
    // And nothing was spent: the gate is in front of the call, not beside it.
    expect(generateChatTitle).not.toHaveBeenCalled();
    // No hold to release — the reservation was refused, not taken.
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("reserves against the resolved target and releases the hold once the call is over", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Exporting a report" });

    // The reservation describes the model that actually ran, or it prices the wrong thing.
    expect(reserveBudget.mock.calls[0][0]).toMatchObject({
      onSharedKey: true, modelId: "gpt-x", provider: "openai", configId: "cfg1",
    });
    const holdId = reserveBudget.mock.calls[0][0].taskId;
    expect(typeof holdId).toBe("string");
    expect(releaseHold).toHaveBeenCalledWith(holdId);
    expect(updates.set).toEqual([{ title: "Exporting a report" }]);
  });

  it("releases the hold even when the model call throws", async () => {
    generateChatTitle.mockRejectedValue(new Error("provider down"));
    const res = await post();
    expect(res.status).toBe(500);
    const holdId = reserveBudget.mock.calls[0][0].taskId;
    expect(releaseHold).toHaveBeenCalledWith(holdId);
  });

  it("takes no hold for a chat with nothing answered yet", async () => {
    loadActivePath.mockResolvedValue([{ node: { role: "user", content: "hello" } }]);
    const res = await post();
    expect(res.status).toBe(409);
    expect(reserveBudget).not.toHaveBeenCalled();
  });
});
