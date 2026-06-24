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

  it("keeps an output-less tool-call as input-available WHILE the turn is running", () => {
    const meta: MessageMeta = {
      status: "running",
      parts: [{ type: "tool-call", id: "t1", name: "write_file", input: { path: "x" } }],
    };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    // Live turn — the tool is genuinely executing, so it must keep its spinner.
    expect(msg.parts[0]).toMatchObject({ type: "dynamic-tool", state: "input-available" });
  });

  it("seals an orphan tool-call (no result, turn finished) as output-error", () => {
    const meta: MessageMeta = {
      status: "failed",
      parts: [{ type: "tool-call", id: "t1", name: "write_file", input: { path: "x" } }],
    };
    const [msg] = toUIMessages([row({ metadata: meta })]);
    // The turn died mid-tool (or this row was copied by a fork): render it as a
    // terminal error, never a forever-spinner — and crucially this makes the
    // model's history a complete call→result pair (no AI_MissingToolResultsError).
    expect(msg.parts[0]).toMatchObject({ type: "dynamic-tool", state: "output-error" });
    expect((msg.parts[0] as { errorText?: string }).errorText).toBeTruthy();
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
    expect(msg.metadata).toEqual({ createdAt: null, platform: "web", taskStatus: "completed", parentId: null, siblingIndex: 0, siblingCount: 1 });
  });

  it("surfaces attachedFiles from metadata so the bubble can show them", () => {
    const files = [
      { name: "photo.png", type: "image/png" },
      { name: "report.pdf", type: "application/pdf" },
    ];
    const [msg] = toUIMessages([row({ role: "user", content: "look", metadata: { attachedFiles: files } })]);
    expect((msg.metadata as { attachedFiles?: unknown }).attachedFiles).toEqual(files);
  });

  it("leaves attachedFiles undefined when none were stored", () => {
    const [msg] = toUIMessages([row({ role: "user", content: "hi", metadata: { status: "completed" } })]);
    expect((msg.metadata as { attachedFiles?: unknown }).attachedFiles).toBeUndefined();
  });

  it("surfaces tech details (duration/model/usage/cost) for the (i) popover", () => {
    const meta: MessageMeta = {
      status: "completed",
      durationMs: 12345,
      model: "anthropic/claude-opus-4.1",
      usage: { input: 1230, output: 456, cached: 12480 },
      costUsd: 0.0123,
    };
    const [msg] = toUIMessages([row({ content: "hi", metadata: meta })]);
    expect(msg.metadata).toMatchObject({
      durationMs: 12345,
      model: "anthropic/claude-opus-4.1",
      usage: { input: 1230, output: 456, cached: 12480 },
      costUsd: 0.0123,
    });
  });

  it("omits tech details when the turn never recorded them", () => {
    const [msg] = toUIMessages([row({ content: "hi", metadata: { status: "completed" } })]);
    const m = msg.metadata as { durationMs?: number; usage?: unknown; costUsd?: number };
    expect(m.durationMs).toBeUndefined();
    expect(m.usage).toBeUndefined();
    expect(m.costUsd).toBeUndefined();
  });
});
