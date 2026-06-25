import { describe, it, expect } from "vitest";
import { stitchOverlap, buildResumeMessages } from "@/lib/tasks/resume";

describe("stitchOverlap", () => {
  it("drops a verbatim repeated overlap", () => {
    expect(stitchOverlap("…the quick brown fox", " fox jumps")).toBe(" jumps");
    expect(stitchOverlap("hello world", "world peace")).toBe(" peace");
  });
  it("no overlap → delta unchanged", () => {
    expect(stitchOverlap("abc", "xyz")).toBe("xyz");
  });
  it("full overlap / empty inputs", () => {
    expect(stitchOverlap("done.", "done.")).toBe("");
    expect(stitchOverlap("", "next")).toBe("next");
    expect(stitchOverlap("prev", "")).toBe("");
  });
});

describe("buildResumeMessages", () => {
  it("[] when nothing replayable (empty / reasoning-only)", async () => {
    expect(await buildResumeMessages("m1", [])).toEqual([]);
    expect(await buildResumeMessages("m1", [{ type: "reasoning", text: "hmm" }] as never)).toEqual([]);
  });
  it("text-only partial ends on a user 'continue' turn (never a prefill)", async () => {
    const msgs = await buildResumeMessages("m1", [{ type: "text", text: "Step one is to" }] as never);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs.at(-1)!.role).toBe("user");
  });
  it("dangling tool-call is sealed into a paired result, ends on user turn", async () => {
    const msgs = await buildResumeMessages("m1", [
      { type: "text", text: "Let me check." },
      { type: "tool-call", id: "t1", name: "read_file", input: { path: "a.ts" } },
    ] as never);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(msgs.at(-1)!.role).toBe("user");
  });
  it("completed tool step is replayed before the continue turn", async () => {
    const msgs = await buildResumeMessages("m1", [
      { type: "text", text: "Reading config." },
      { type: "tool-call", id: "t1", name: "read_file", input: { path: "cfg.json" } },
      { type: "tool-result", id: "t1", name: "read_file", output: { ok: true } },
      { type: "text", text: "The config enables" },
    ] as never);
    expect(msgs.some((m) => m.role === "tool")).toBe(true);
    expect(msgs.at(-1)!.role).toBe("user");
  });
});
