import { describe, it, expect } from "vitest";
import { toUIMessages } from "../presenter";
import type { MessageMeta } from "../contracts";

type Row = Parameters<typeof toUIMessages>[0][number];

function row(over: Partial<Row> & { metadata?: MessageMeta | null }): Row {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    metadata: null,
    createdAt: new Date("2026-06-09T12:00:00.000Z"),
    platform: "web",
    ...over,
  };
}

describe("toUIMessages", () => {
  it("renders the parts format preserving text → tools → text order", () => {
    const meta: MessageMeta = {
      parts: [
        { type: "text", text: "before" },
        { type: "tool-call", id: "t1", name: "execute_bash", input: { cmd: "ls" } },
        { type: "tool-result", id: "t1", name: "execute_bash", output: { stdout: "a" } },
        { type: "text", text: "after" },
      ],
    };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    expect(msg.parts).toEqual([
      { type: "text", text: "before" },
      expect.objectContaining({
        type: "dynamic-tool",
        toolCallId: "t1",
        toolName: "execute_bash",
        state: "output-available",
        output: { stdout: "a" },
      }),
      { type: "text", text: "after" },
    ]);
  });

  it("marks a tool-call with no result yet as input-available (valid AI SDK 6 state)", () => {
    const meta: MessageMeta = {
      parts: [{ type: "tool-call", id: "t1", name: "write_file", input: { path: "x" } }],
    };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    expect(msg.parts[0]).toMatchObject({ type: "dynamic-tool", state: "input-available" });
  });

  it("surfaces tool-error as output-error with errorText", () => {
    const meta: MessageMeta = {
      parts: [
        { type: "tool-call", id: "t1", name: "execute_bash", input: {} },
        { type: "tool-error", id: "t1", name: "execute_bash", error: "boom" },
      ],
    };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    expect(msg.parts[0]).toMatchObject({ type: "dynamic-tool", state: "output-error", errorText: "boom" });
  });

  it("drops empty text parts", () => {
    const meta: MessageMeta = { parts: [{ type: "text", text: "" }, { type: "text", text: "hi" }] };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    expect(msg.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("handles the legacy toolCalls/toolResults format (tools first, then content)", () => {
    const meta: MessageMeta = {
      toolCalls: [
        { id: "t1", name: "execute_bash", input: { cmd: "ls" } },
        { id: "t2", name: "write_file", input: {} },
      ],
      toolResults: [{ id: "t1", name: "execute_bash", output: { ok: true } }],
    };
    const [msg] = toUIMessages([row({ content: "done", metadata: meta })]);
    expect(msg.parts[0]).toMatchObject({ toolCallId: "t1", state: "output-available" });
    // No matching result → legacy format marks it output-error.
    expect(msg.parts[1]).toMatchObject({ toolCallId: "t2", state: "output-error" });
    expect(msg.parts[2]).toEqual({ type: "text", text: "done" });
  });

  it("falls back to plain content when there is no metadata", () => {
    const [msg] = toUIMessages([row({ content: "just text", metadata: null })]);
    expect(msg.parts).toEqual([{ type: "text", text: "just text" }]);
  });

  it("normalizes metadata: ISO createdAt, default platform, taskStatus", () => {
    const [msg] = toUIMessages([
      row({ content: "x", metadata: { status: "completed" }, platform: null, createdAt: null }),
    ]);
    expect(msg.metadata).toEqual({ createdAt: null, platform: "web", taskStatus: "completed" });
  });
});
