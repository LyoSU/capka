import { describe, it, expect } from "vitest";
import { workspaceSessionKey } from "@/lib/sandbox/workspace";

describe("workspaceSessionKey", () => {
  it("uses the project id when the chat belongs to a project (shared folder)", () => {
    expect(workspaceSessionKey({ id: "chat-1", projectId: "proj-9" })).toBe("proj-9");
  });

  it("falls back to the chat id for a standalone chat (private scratch)", () => {
    expect(workspaceSessionKey({ id: "chat-1", projectId: null })).toBe("chat-1");
  });

  it("treats all chats of one project as the same key", () => {
    const a = workspaceSessionKey({ id: "chat-a", projectId: "proj-9" });
    const b = workspaceSessionKey({ id: "chat-b", projectId: "proj-9" });
    expect(a).toBe(b);
  });
});
