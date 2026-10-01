import { describe, it, expect } from "vitest";
import { INTERRUPTED_TOOL_RESULT, UNANSWERED_ASK_RESULT, UNDECIDED_APPROVAL_REASON, sealOrphanToolCalls } from "../tool-results";

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

  it("seals a declined approval as denied, and leaves an approved one for the resume to run", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        parts: [
          { type: "dynamic-tool", toolCallId: "c1", toolName: "manage", state: "approval-responded", approval: { id: "a1", approved: false } },
          { type: "dynamic-tool", toolCallId: "c2", toolName: "manage", state: "approval-responded", approval: { id: "a2", approved: true } },
        ],
      },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0].state).toBe("output-denied");
    expect(msgs[0].parts![1].state).toBe("approval-responded");
  });

  it("seals an approved call as interrupted once its message is no longer the last", () => {
    const approvedCall = () => ({ type: "dynamic-tool", toolCallId: "c2", toolName: "manage", state: "approval-responded", approval: { id: "a2", approved: true } });
    const msgs: Msg[] = [
      { role: "assistant", parts: [approvedCall()] },
      { role: "user", parts: [{ type: "text", text: "hello again" }] },
      { role: "assistant", parts: [approvedCall()] },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0]).toMatchObject({ state: "output-error", errorText: INTERRUPTED_TOOL_RESULT, approval: { approved: true } });
    expect(msgs[2].parts![0].state).toBe("approval-responded");
  });

  it("seals an undecided approval as declined once its message is no longer the last", () => {
    const waiting = () => ({ type: "dynamic-tool", toolCallId: "c3", toolName: "manage", state: "approval-requested", approval: { id: "a3" } });
    const msgs: Msg[] = [
      { role: "assistant", parts: [waiting()] },
      { role: "user", parts: [{ type: "text", text: "never mind" }] },
      { role: "assistant", parts: [waiting()] },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0]).toMatchObject({ state: "output-denied", approval: { id: "a3", approved: false, reason: UNDECIDED_APPROVAL_REASON } });
    expect(msgs[2].parts![0]).toEqual(waiting());
  });

  it("says an ask nobody answered was not answered rather than interrupted", () => {
    const msgs: Msg[] = [
      { role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: "q", toolName: "ask", state: "input-available", askForm: { fields: [] } }] },
      { role: "user", parts: [{ type: "text", text: "skip that" }] },
    ];
    sealOrphanToolCalls(msgs);
    expect(msgs[0].parts![0]).toMatchObject({ state: "output-error", errorText: UNANSWERED_ASK_RESULT });
  });

  it("ignores user messages and non-tool parts", () => {
    const msgs: Msg[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
    const before = JSON.stringify(msgs);
    sealOrphanToolCalls(msgs);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});
