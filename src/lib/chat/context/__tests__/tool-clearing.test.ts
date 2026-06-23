import { describe, it, expect } from "vitest";
import { clearStaleToolResults, CLEARED_TOOL_OUTPUT } from "@/lib/chat/context/tool-clearing";
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

    // The tool-call (arguments) is never touched — the model still sees what ran.
    expect(out[0].parts![0]).toEqual(toolCall("1"));
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
