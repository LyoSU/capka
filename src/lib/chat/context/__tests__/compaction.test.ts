import { describe, it, expect } from "vitest";
import { applyCompaction, type CtxMessage } from "@/lib/chat/context/compaction";
import type { StoredPart } from "@/lib/chat/contracts";

const text = (t: string): StoredPart[] => [{ type: "text", text: t }];

const msg = (id: string, role: string, t: string): CtxMessage => ({ id, role, parts: text(t) });
const checkpoint = (id: string, summary: string, upTo: string): CtxMessage => ({
  id,
  role: "assistant",
  compaction: { summary, summarizedUpTo: upTo },
});

describe("applyCompaction", () => {
  it("returns the input unchanged when there is no checkpoint", () => {
    const msgs = [msg("a", "user", "hi"), msg("b", "assistant", "hello")];
    expect(applyCompaction(msgs)).toBe(msgs);
  });

  it("replaces everything up to and including the checkpoint with one summary message", () => {
    const msgs = [
      msg("a", "user", "old 1"),
      msg("b", "assistant", "old 2"),
      checkpoint("cp", "User is building a Next.js app; bug in auth unresolved.", "b"),
      msg("c", "user", "new question"),
      msg("d", "assistant", "new answer"),
    ];

    const out = applyCompaction(msgs);

    expect(out).toHaveLength(3); // summary + c + d
    expect(out[0].role).toBe("user");
    const summaryText = out[0].parts?.find((p) => p.type === "text") as { text: string } | undefined;
    expect(summaryText?.text).toContain("building a Next.js app");
    expect(out[1].id).toBe("c");
    expect(out[2].id).toBe("d");
    // The old turns are gone for the model.
    expect(out.some((m) => m.id === "a" || m.id === "b")).toBe(false);
  });

  it("uses the newest checkpoint when several exist, folding the older one into the summarized zone", () => {
    const msgs = [
      msg("a", "user", "ancient"),
      checkpoint("cp1", "first summary", "a"),
      msg("b", "user", "middle"),
      checkpoint("cp2", "second summary (includes first)", "b"),
      msg("c", "user", "recent"),
    ];

    const out = applyCompaction(msgs);

    expect(out).toHaveLength(2); // newest summary + c
    const summaryText = out[0].parts?.find((p) => p.type === "text") as { text: string } | undefined;
    expect(summaryText?.text).toContain("second summary");
    expect(out[1].id).toBe("c");
  });
});
