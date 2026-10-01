import { describe, it, expect } from "vitest";
import { latestPlan, planLines, PLAN_TOOL } from "@/lib/chat/plan";
import { composeDraft } from "@/lib/tasks/delivery";

const call = (steps: unknown, type = "dynamic-tool") => ({ type, toolName: PLAN_TOOL, input: { steps } });
const a = [
  { title: "Read the spreadsheet", status: "done" },
  { title: "Build the chart", status: "current" },
  { title: "Write the summary", status: "pending" },
] as const;

describe("latestPlan", () => {
  it("is null for a turn that never made a plan", () => {
    expect(latestPlan([{ type: "text" }, { type: "dynamic-tool", toolName: "execute_python", input: {} }], true)).toBeNull();
  });

  it("takes the latest call, whole list, and skips one still streaming or malformed", () => {
    const first = call([{ title: "Read", status: "current" }, { title: "Write", status: "pending" }]);
    const parts = [first, { type: "dynamic-tool", toolName: "execute_python" }, call(a), call([{ title: "half" }])];
    expect(latestPlan(parts, true)).toEqual(a);
  });

  it("reads the persisted shapes too (tool-call parts and typed tool parts)", () => {
    expect(latestPlan([{ type: "tool-call", name: PLAN_TOOL, input: { steps: a } }], true)).toEqual(a);
    expect(latestPlan([{ type: `tool-${PLAN_TOOL}`, input: { steps: a } }], true)).toEqual(a);
  });

  it("ticks a step left current once the turn is over, but never a pending one", () => {
    expect(latestPlan([call(a)], false)?.map((s) => s.status)).toEqual(["done", "done", "pending"]);
  });
});

describe("plan in the Telegram draft", () => {
  const t = ((k: string) => k) as never;

  it("heads the thinking block with the checklist while the work runs", () => {
    const d = composeDraft("", "", { kind: "tool", label: "Running a command", plan: [...a] }, t);
    expect(d).toEqual({ html: `<tg-thinking>${planLines([...a])}\n\n🔧 Running a command</tg-thinking>` });
    expect(planLines([...a])).toBe("✓ Read the spreadsheet\n⟳ Build the chart\n○ Write the summary");
  });

  it("gives way to the answer once there is one", () => {
    expect(composeDraft("Here it is", "", { kind: "tool", label: "x", plan: [...a] }, t)).toEqual({ markdown: "Here it is" });
  });
});
