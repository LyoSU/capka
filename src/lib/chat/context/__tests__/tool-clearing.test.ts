import { describe, it, expect } from "vitest";
import { clearStaleToolResults, CLEARED_TOOL_OUTPUT, CLEARED_TOOL_INPUT } from "@/lib/chat/context/tool-clearing";
import type { StoredPart } from "@/lib/chat/contracts";

/** A minimal message shape carrying ordered parts — mirrors what the runner
 *  walks over the active path before handing context to the model. */
type Msg = { id: string; role: string; parts?: StoredPart[] };

function toolCall(id: string): StoredPart {
  return { type: "tool-call", id, name: "read_file", input: { path: `/f/${id}` } };
}
function toolResult(id: string, output: unknown): StoredPart {
  return { type: "tool-result", id, name: "read_file", output };
}

describe("clearStaleToolResults", () => {
  it("clears tool-result outputs deeper than the last K, counting globally across messages", () => {
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [toolCall("1"), toolResult("1", "FIRST big output")] },
      { id: "b", role: "assistant", parts: [toolCall("2"), toolResult("2", "SECOND big output")] },
      { id: "c", role: "assistant", parts: [toolCall("3"), toolResult("3", "THIRD")] },
      { id: "d", role: "assistant", parts: [toolCall("4"), toolResult("4", "FOURTH")] },
    ];

    const out = clearStaleToolResults(msgs, 2);

    // The two oldest results are cleared; the two most recent survive intact.
    const result = (m: Msg, id: string) =>
      m.parts?.find((p): p is Extract<StoredPart, { type: "tool-result" }> => p.type === "tool-result" && p.id === id);
    expect(result(out[0], "1")!.output).toBe(CLEARED_TOOL_OUTPUT);
    expect(result(out[1], "2")!.output).toBe(CLEARED_TOOL_OUTPUT);
    expect(result(out[2], "3")!.output).toBe("THIRD");
    expect(result(out[3], "4")!.output).toBe("FOURTH");

    // The stale call's ARGUMENTS go with its result — on a write-heavy turn they
    // are the heavier half — but its name and id survive so the timeline reads.
    const call = out[0].parts![0] as Extract<StoredPart, { type: "tool-call" }>;
    expect(call.input).toBe(CLEARED_TOOL_INPUT);
    expect(call.name).toBe("read_file");
    expect(call.id).toBe("1");
    // A surviving exchange keeps its arguments verbatim.
    expect(out[3].parts![0]).toEqual(toolCall("4"));
  });

  it("clears a stale call's arguments even when the call sits in another message", () => {
    // A suspended/approved call and its eventual result land in different turns,
    // so pairing has to go by tool-call id, not by position.
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [toolCall("1")] },
      { id: "b", role: "tool", parts: [toolResult("1", "big output")] },
      { id: "c", role: "assistant", parts: [toolCall("2"), toolResult("2", "keep")] },
    ];

    const out = clearStaleToolResults(msgs, 1);

    expect((out[0].parts![0] as Extract<StoredPart, { type: "tool-call" }>).input).toBe(CLEARED_TOOL_INPUT);
    expect((out[1].parts![0] as Extract<StoredPart, { type: "tool-result" }>).output).toBe(CLEARED_TOOL_OUTPUT);
    // The kept exchange is untouched on both halves.
    expect(out[2].parts![0]).toEqual(toolCall("2"));
    expect((out[2].parts![1] as Extract<StoredPart, { type: "tool-result" }>).output).toBe("keep");
  });

  it("leaves a call with no result yet alone — nothing about it is stale", () => {
    // The live call at the head of an in-flight step has no result to age out.
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [toolCall("1"), toolResult("1", "old")] },
      { id: "b", role: "assistant", parts: [toolCall("2"), toolResult("2", "old")] },
      { id: "c", role: "assistant", parts: [toolCall("3")] },
    ];
    const out = clearStaleToolResults(msgs, 1);
    expect(out[2].parts![0]).toEqual(toolCall("3"));
  });

  it("returns the input unchanged when there are no more than K results", () => {
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [toolCall("1"), toolResult("1", "out")] },
      { id: "b", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];
    expect(clearStaleToolResults(msgs, 3)).toBe(msgs);
  });

  it("never clears tool-error parts — they are small and high-signal", () => {
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [{ type: "tool-error", id: "1", name: "x", error: "boom" }] },
      { id: "b", role: "assistant", parts: [toolCall("2"), toolResult("2", "keep")] },
      { id: "c", role: "assistant", parts: [toolCall("3"), toolResult("3", "keep")] },
    ];
    const out = clearStaleToolResults(msgs, 1);
    expect(out[0].parts![0]).toEqual({ type: "tool-error", id: "1", name: "x", error: "boom" });
  });

  it("does not mutate the input messages", () => {
    const msgs: Msg[] = [
      { id: "a", role: "assistant", parts: [toolCall("1"), toolResult("1", "orig")] },
      { id: "b", role: "assistant", parts: [toolCall("2"), toolResult("2", "orig")] },
    ];
    clearStaleToolResults(msgs, 1);
    const r = msgs[0].parts!.find((p) => p.type === "tool-result") as Extract<StoredPart, { type: "tool-result" }>;
    expect(r.output).toBe("orig");
  });
});
