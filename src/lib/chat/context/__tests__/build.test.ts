import { describe, it, expect } from "vitest";
import { buildModelContext, type ContextRow } from "@/lib/chat/context/build";
import { CLEARED_TOOL_OUTPUT } from "@/lib/chat/context/tool-clearing";
import { SUMMARY_HEADING } from "@/lib/chat/context/compaction";
import type { StoredPart } from "@/lib/chat/contracts";

const row = (id: string, role: string, parts?: StoredPart[], extra?: object): ContextRow => ({
  id, role, content: "", metadata: { parts, ...extra }, createdAt: null, platform: "web",
});
const tc = (id: string): StoredPart => ({ type: "tool-call", id, name: "read_file", input: {} });
const tr = (id: string, out: unknown): StoredPart => ({ type: "tool-result", id, name: "read_file", output: out });

describe("buildModelContext", () => {
  it("collapses history at the checkpoint, then clears stale tool results in the surviving tail", () => {
    const rows: ContextRow[] = [
      row("a", "user", [{ type: "text", text: "old question" }]),
      row("b", "assistant", [tc("1"), tr("1", "OLD big output")]),
      { ...row("cp", "assistant"), metadata: { compaction: { summary: "App uses Next.js; auth bug open.", summarizedUpTo: "b" } } },
      row("c", "assistant", [tc("2"), tr("2", "r2"), tc("3"), tr("3", "r3"), tc("4"), tr("4", "r4")]),
    ];

    const out = buildModelContext(rows, { clearToolsKeepLast: 2 });

    // Compaction: only [summary, c] survive for the model.
    expect(out).toHaveLength(2);
    const meta0 = out[0].metadata as { parts?: StoredPart[] };
    const summaryText = meta0.parts?.find((p) => p.type === "text") as { text: string } | undefined;
    expect(summaryText?.text).toContain(SUMMARY_HEADING);
    expect(summaryText?.text).toContain("Next.js");

    // Clearing (global, keep last 2 of the 3 results in the tail): r2 cleared, r3/r4 kept.
    const tail = out[1].metadata as { parts?: StoredPart[] };
    const result = (id: string) =>
      tail.parts?.find((p): p is Extract<StoredPart, { type: "tool-result" }> => p.type === "tool-result" && p.id === id);
    expect(result("2")!.output).toBe(CLEARED_TOOL_OUTPUT);
    expect(result("3")!.output).toBe("r3");
    expect(result("4")!.output).toBe("r4");
  });

  it("is a no-op pass-through when there's no checkpoint and clearing is disabled", () => {
    const rows: ContextRow[] = [row("a", "user", [{ type: "text", text: "hi" }])];
    expect(buildModelContext(rows, {})).toEqual(rows);
  });
});
