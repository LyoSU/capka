import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];

const { destroySession } = vi.hoisted(() => ({ destroySession: vi.fn() }));
vi.mock("@/lib/sandbox/client", () => ({ destroySession }));
vi.mock("@/lib/log", () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));

const h = vi.hoisted(() => ({
  db: {
    delete: () => ({
      where: () => {
        (globalThis as { __c?: string[] }).__c?.push("delete");
        return Promise.resolve();
      },
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: h.db }));

import { deleteChat } from "@/lib/chat/teardown";

beforeEach(() => {
  calls.length = 0;
  (globalThis as { __c?: string[] }).__c = calls;
  destroySession.mockReset().mockImplementation(async () => { calls.push("destroySession"); });
});

describe("deleteChat", () => {
  it("tears down the sandbox and the folder rows for a chat with no project", async () => {
    await deleteChat({ id: "c1", userId: "u1", projectId: null });
    expect(destroySession).toHaveBeenCalledWith("c1", "u1");
    expect(calls).toEqual(["destroySession", "delete", "delete"]); // folders + chat row
  });

  it("leaves the shared workspace alone for a chat inside a project", async () => {
    // workspaceSessionKey is `projectId ?? chatId`, so this chat's files and folder
    // attachments belong to the project and its sibling chats.
    await deleteChat({ id: "c1", userId: "u1", projectId: "p1" });
    expect(destroySession).not.toHaveBeenCalled();
    expect(calls).toEqual(["delete"]); // the chat row only
  });

  it("still deletes the rows when the controller is unreachable", async () => {
    destroySession.mockReset().mockRejectedValue(new Error("ECONNREFUSED"));
    await deleteChat({ id: "c1", userId: "u1", projectId: null });
    expect(calls).toEqual(["delete", "delete"]);
  });
});
