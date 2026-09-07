import { describe, it, expect } from "vitest";
import { makeQuietTool, QUIET_ACK, type QuietState } from "../quiet-tool";

/** The AI SDK's `tool()` keeps whatever `execute` it was handed; the runner never
 *  calls it directly, so the test does — with the shape the SDK passes. */
async function call(tools: Record<string, unknown>, reason: string) {
  const t = tools.nothing_to_report as { execute: (args: { reason: string }) => Promise<string> };
  return t.execute({ reason });
}

describe("makeQuietTool", () => {
  it("is offered to an automation run whose owner asked to be told only when needed", () => {
    const tools = makeQuietTool({ automationId: "a1", notifyMode: "when_needed" }, {});
    expect(Object.keys(tools)).toEqual(["nothing_to_report"]);
  });

  // The gate has two halves, and each one alone is a way to hand the tool to a
  // turn that must never end silently: an ordinary chat, or an automation whose
  // owner asked to hear from every run.
  it("is NOT offered when the automation reports every run", () => {
    expect(makeQuietTool({ automationId: "a1", notifyMode: "always" }, {})).toEqual({});
  });

  it("is NOT offered to a turn that is not an automation run", () => {
    expect(makeQuietTool({ notifyMode: "when_needed" }, {})).toEqual({});
    expect(makeQuietTool({}, {})).toEqual({});
  });

  it("flips the run's flag and tells the model to stop writing", async () => {
    const state: QuietState = {};
    const tools = makeQuietTool({ automationId: "a1", notifyMode: "when_needed" }, state);
    const out = await call(tools, "No new invoices in the inbox.");
    expect(state.reason).toBe("No new invoices in the inbox.");
    expect(out).toBe(QUIET_ACK);
  });

  it("leaves the flag unset until the model actually calls it", () => {
    const state: QuietState = {};
    makeQuietTool({ automationId: "a1", notifyMode: "when_needed" }, state);
    expect(state.reason).toBeUndefined();
  });

  // The reason is shown to the user as the quiet row's caption, so it is bounded
  // at the schema rather than truncated somewhere downstream.
  it("refuses a reason longer than 300 characters", () => {
    const tools = makeQuietTool({ automationId: "a1", notifyMode: "when_needed" }, {});
    const schema = (tools.nothing_to_report as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;
    expect(schema.safeParse({ reason: "x".repeat(300) }).success).toBe(true);
    expect(schema.safeParse({ reason: "x".repeat(301) }).success).toBe(false);
  });
});
