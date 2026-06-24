import { describe, it, expect } from "vitest";
import { sealOrphanToolCalls } from "../tool-results";

type Part = Record<string, unknown>;
type Msg = { role: string; parts?: Part[] };

describe("sealOrphanToolCalls", () => {
  it("turns a tool call with no result into a terminal error (the fork-killer)", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Running it now" },
          { type: "dynamic-tool", toolCallId: "call_044a", toolName: "execute_bash", state: "input-available", input: { cmd: "ls" } },
        ],
      },
    ];
    sealOrphanToolCalls(msgs);
    const tool = msgs[0].parts![1];
    expect(tool.state).toBe("output-error");
    expect(tool.errorText).toBeTruthy();
    // Surrounding text is preserved — we seal the call, we don't drop the message.
    expect(msgs[0].parts![0]).toEqual({ type: "text", text: "Running it now" });
  });

  it("seals a still-streaming input as well", () => {
    const msgs: Msg[] = [
      { role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: "c", toolName: "x", state: "input-streaming" }] },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0].state).toBe("output-error");
  });

  it("leaves a completed tool call untouched", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        parts: [{ type: "dynamic-tool", toolCallId: "c1", toolName: "bash", state: "output-available", input: {}, output: { ok: true } }],
      },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0].state).toBe("output-available");
    expect(msgs[0].parts![0].output).toEqual({ ok: true });
  });

  it("does not clobber an existing error message", () => {
    const msgs: Msg[] = [
      { role: "assistant", parts: [{ type: "dynamic-tool", state: "output-error", errorText: "real failure" }] },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0].errorText).toBe("real failure");
  });

  it("ignores user messages and non-tool parts", () => {
    const msgs: Msg[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    const before = JSON.stringify(msgs);
    sealOrphanToolCalls(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
