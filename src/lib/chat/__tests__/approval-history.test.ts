import { describe, it, expect } from "vitest";
import { convertToModelMessages, jsonSchema, streamText, tool, type ModelMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { toUIMessages } from "../presenter";
import { INTERRUPTED_TOOL_RESULT, UNANSWERED_ASK_RESULT, UNDECIDED_APPROVAL_REASON, sealOrphanToolCalls } from "../tool-results";
import type { MessageMeta, StoredPart } from "../contracts";

// Anthropic and OpenAI reject a tool call with no result, so an approval that
// leaves one behind breaks every later send in the chat. These run the stored row
// through the same pipeline the runner uses and read the prompt the provider gets.

type Row = Parameters<typeof toUIMessages>[0][number];
const row = (id: string, role: string, metadata: MessageMeta | null, content = ""): Row =>
  ({ id, role, content, metadata, createdAt: new Date("2026-10-01T12:00:00.000Z"), platform: "web" });

const ask = row("u1", "user", null, "delete the old report");
const later = row("u2", "user", null, "hello again");
const call: StoredPart = { type: "tool-call", id: "c1", name: "manage", input: { action: "remove" }, approval: { id: "ap1", approved: false } };
const declined = row("a1", "assistant", { status: "completed", parts: [call] });

/** What the provider is actually sent for this history, and whether the tool ran. */
async function providerPrompt(rows: Row[]) {
  const history = await convertToModelMessages(sealOrphanToolCalls(toUIMessages(rows)) as never);
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } }],
      }),
    }),
  });
  let executed = false;
  const chunks: string[] = [];
  const r = streamText({
    model,
    messages: history as ModelMessage[],
    // Gated, as the runner builds it: the SDK re-checks an approved call and denies
    // one whose tool no longer needs approval instead of running it.
    tools: { manage: tool({ inputSchema: jsonSchema({ type: "object" }), needsApproval: true, execute: async () => { executed = true; return "ok"; } }) },
  });
  for await (const c of r.fullStream) chunks.push(c.type);
  const prompt = model.doStreamCalls[0].prompt;
  const results = prompt.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "tool-result"));
  return { prompt, results, executed, chunks };
}

describe("approval history reaches the provider with a result for every call", () => {
  it("a declined approval followed by a new message carries the denial as the call's result", async () => {
    const { prompt, results, executed } = await providerPrompt([ask, declined, later]);
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(results).toEqual([
      expect.objectContaining({ toolCallId: "c1", output: { type: "error-text", value: "Tool call execution denied." } }),
    ]);
    expect(executed).toBe(false);
  });

  it("the user's decline reason is what the model reads", async () => {
    const withReason = row("a1", "assistant", { status: "completed", parts: [{ ...call, approval: { id: "ap1", approved: false, reason: "not now" } } as StoredPart] });
    const { results } = await providerPrompt([ask, withReason, later]);
    expect(results).toEqual([expect.objectContaining({ output: { type: "error-text", value: "not now" } })]);
  });

  it("the resume that ends on the decline still gets exactly one denial and never runs the tool", async () => {
    const { prompt, results, executed } = await providerPrompt([ask, declined]);
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "c1", output: { type: "error-text" } });
    expect(executed).toBe(false);
  });

  it("an approved call that threw carries its error as the result", async () => {
    const threw = row("a1", "assistant", {
      status: "completed",
      parts: [
        { ...call, approval: { id: "ap1", approved: true } } as StoredPart,
        { type: "tool-error", id: "c1", name: "manage", error: "Connector refused the change" },
      ],
    });
    const { results, executed } = await providerPrompt([ask, threw, later]);
    expect(results).toEqual([
      expect.objectContaining({ toolCallId: "c1", output: { type: "error-text", value: "Connector refused the change" } }),
    ]);
    expect(executed).toBe(false);
  });

  // The resume re-checks an approved call and drops it — connector gone, or no longer
  // gated — without storing anything, so the finished row holds an approval and no result.
  const approved = { ...call, approval: { id: "ap1", approved: true } } as StoredPart;
  const notRun = { status: "error", code: "NOT_RUN", error: "Not run. This approved call never ran, so it has no result." };

  it("an approved call that never ran on a finished turn carries a not-run result", async () => {
    const finished = row("a1", "assistant", { status: "completed", parts: [approved, { type: "text", text: "Done." }] });
    const { results, executed } = await providerPrompt([ask, finished, later]);
    expect(results).toEqual([expect.objectContaining({ toolCallId: "c1", output: { type: "json", value: notRun } })]);
    expect(executed).toBe(false);
  });

  // Stop, the deadline or a lost lease can end the continuation while the approved
  // call is still running: the stream yields neither result nor error, yet its effect
  // may land. Saying it never ran would have the user approve it a second time.
  it("an approved call whose turn was stopped or failed reads as interrupted, never as not-run", async () => {
    for (const status of ["cancelled", "failed"]) {
      const stopped = row("a1", "assistant", { status, parts: [approved] });
      const { results, executed } = await providerPrompt([ask, stopped, later]);
      expect(results).toEqual([expect.objectContaining({ toolCallId: "c1", output: { type: "error-text", value: INTERRUPTED_TOOL_RESULT } })]);
      expect(JSON.stringify(results)).not.toContain("never ran");
      expect(executed).toBe(false);
    }
  });

  // A continuation cancelled while still queued never writes the row, so it stays
  // awaiting_approval with the decision recorded — and a later message follows it.
  it("an approved call left awaiting a continuation that will never run is sealed once a later message follows", async () => {
    const stranded = row("a1", "assistant", { status: "awaiting_approval", parts: [approved] });
    const { prompt, results, executed } = await providerPrompt([ask, stranded, later]);
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(results).toEqual([expect.objectContaining({ toolCallId: "c1", output: { type: "error-text", value: INTERRUPTED_TOOL_RESULT } })]);
    expect(executed).toBe(false);
  });

  it("the resume of a just-approved call still runs it, exactly once", async () => {
    const waiting = row("a1", "assistant", { status: "awaiting_approval", parts: [approved] });
    const { results, executed } = await providerPrompt([ask, waiting]);
    expect(executed).toBe(true);
    expect(results).toEqual([expect.objectContaining({ toolCallId: "c1", output: { type: "text", value: "ok" } })]);
  });

  it("the card reads not-run on a completed turn, interrupted on any other finished one, and spins only while the continuation is pending", () => {
    const at = (status?: string) => toUIMessages([row("a1", "assistant", { status, parts: [approved] })])[0].parts[0];
    expect(at("completed")).toMatchObject({ state: "output-available", output: notRun, approval: { approved: true } });
    for (const status of ["failed", "cancelled", undefined]) {
      expect(at(status)).toMatchObject({ state: "output-error", errorText: INTERRUPTED_TOOL_RESULT, approval: { approved: true } });
    }
    expect(at("awaiting_approval")).toMatchObject({ state: "approval-responded", approval: { approved: true } });
    expect(at("running")).toMatchObject({ state: "approval-responded", approval: { approved: true } });
  });

  // Telegram chains a new message onto a reply whose card is still waiting, and so
  // does a follow-up queued while that reply ran. Left bare, the call broke every
  // later turn in the chat with AI_MissingToolResultsError.
  const undecided = { ...call, approval: { id: "ap1" } } as StoredPart;

  it("an undecided approval the chat moved past is sealed as declined, and the model reads why", async () => {
    const waiting = row("a1", "assistant", { status: "awaiting_approval", parts: [undecided] });
    const { prompt, results, executed } = await providerPrompt([ask, waiting, later]);
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(results).toEqual([expect.objectContaining({ toolCallId: "c1", output: { type: "error-text", value: UNDECIDED_APPROVAL_REASON } })]);
    expect(executed).toBe(false);
  });

  it("an unanswered ask the chat moved past reads as unanswered, not interrupted", async () => {
    const question: StoredPart = { type: "tool-call", id: "q1", name: "ask", input: {}, answer: { form: { fields: [{ id: "row", label: "Which row?", kind: "text" }] } } };
    const waiting = row("a1", "assistant", { status: "awaiting_answer", parts: [question] });
    const { results } = await providerPrompt([ask, waiting, later]);
    expect(results).toEqual([expect.objectContaining({ toolCallId: "q1", output: { type: "error-text", value: UNANSWERED_ASK_RESULT } })]);
  });

  it("an undecided approval on the last message stays a live request", () => {
    const ui = toUIMessages([ask, row("a1", "assistant", { status: "awaiting_approval", parts: [undecided] })]);
    sealOrphanToolCalls(ui);
    expect(ui[1].parts[0]).toMatchObject({ state: "approval-requested", approval: { id: "ap1" } });
    expect((ui[1].parts[0] as { approval: { approved?: boolean } }).approval.approved).toBeUndefined();
  });

  it("the transcript keeps the declined card as it is — the seal is for model history only", () => {
    const [ui] = toUIMessages([declined]);
    expect(ui.parts[0]).toMatchObject({ state: "approval-responded", approval: { approved: false } });
  });
});
