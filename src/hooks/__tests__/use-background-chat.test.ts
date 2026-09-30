import { describe, it, expect } from "vitest";
import { resetReply } from "@/hooks/use-background-chat";

/**
 * A runner retry throws its partial reply away and says so with `task:reset`. On an
 * approval continuation it keeps the suspended half (the approval card and the steps
 * before it), and the live view has to keep them too, not blank the reply until a
 * reload brings them back.
 */
describe("resetReply", () => {
  const card = (id: string) => ({ type: "dynamic-tool", toolCallId: id, toolName: "save_row", state: "output-available" });
  const msgs = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "save the row" }] },
    { id: "a1", role: "assistant", parts: [card("c1"), card("c2"), { type: "text", text: "Saving" }] },
  ];

  it("keeps the suspended half and drops what the abandoned attempt streamed", () => {
    const next = resetReply(msgs, { messageId: "a1", keep: 2 });
    expect(next[1].parts).toEqual([card("c1"), card("c2")]);
    expect(next[0]).toBe(msgs[0]);
    expect(msgs[1].parts).toHaveLength(3); // our copy is replaced, not edited in place
  });

  it("clears the whole reply for a fresh turn, and for a runner that sends no count", () => {
    expect(resetReply(msgs, { messageId: "a1", keep: 0 })[1].parts).toEqual([]);
    expect(resetReply(msgs, { messageId: "a1" })[1].parts).toEqual([]);
  });

  it("leaves the transcript alone when the reply is not in it", () => {
    expect(resetReply(msgs, { messageId: "gone", keep: 2 })).toBe(msgs);
  });
});
