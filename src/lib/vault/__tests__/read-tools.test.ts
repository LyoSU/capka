import { describe, it, expect, vi } from "vitest";

/**
 * `memory_open`'s ONE off-channel arm. The memory tools are registered `untrustedOutput:
 * false` (`capkaAuthored` in `tools.ts`) because every other arm mints through the
 * memory-tool channel, which admits no `untrusted_derived` row. A document handle is the
 * exception: its title is evidence-channel text that a person or an upload supplied, and a
 * turn that read it has read outside content. So that arm marks the taint itself, and this
 * is the pin — a mocked mint, a real taint, no database.
 */
const { openSourceForModel, openNoteForModel, openClaimForModel } = vi.hoisted(() => ({
  openSourceForModel: vi.fn(),
  openNoteForModel: vi.fn(),
  openClaimForModel: vi.fn(),
}));
vi.mock("../model-view", () => ({ openSourceForModel, openNoteForModel, openClaimForModel }));

import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { makeVaultBudget } from "../budget";
import { makeHandleMap } from "../handles";
import { memoryOpen } from "../read-tools";
import type { WriteCtx } from "../write-tools";

const US = "space-user";

const ctxWith = () => {
  const taint = makeTurnTaint({ messageId: "m1", seeded: false, write: async () => {} });
  const ctx: WriteCtx = {
    userSpaceId: US,
    projectSpaceId: null,
    handles: makeHandleMap(),
    taint,
    budget: makeVaultBudget(),
    taskId: "t1",
    messageId: "m1",
    userTurnText: "",
    actor: { kind: "agent" },
  };
  return { ctx, taint };
};

describe("memory_open and the turn's taint", () => {
  it("opening a DOCUMENT handle marks the turn as having read outside content", async () => {
    const { ctx, taint } = ctxWith();
    openSourceForModel.mockResolvedValue({
      ok: true,
      item: { title: "vendor-terms.pdf", versions: [{ observedAt: new Date(0), status: "ready", superseded: false }] },
    });
    const handle = ctx.handles.mint({ kind: "f", spaceId: US, nodeId: "src1" });
    const r = await memoryOpen({ handle, ctx });
    expect(r).toMatchObject({ status: "opened", kind: "source" });
    expect(taint.seen()).toBe(true);
  });

  it("opening a NOTE handle does not: its body came through the memory-tool channel", async () => {
    // The control, and the one that matters: without it the case above passes for a
    // `memoryOpen` that marks unconditionally, which is exactly the mark-everything the
    // declaration exists to remove.
    const { ctx, taint } = ctxWith();
    openNoteForModel.mockResolvedValue({
      ok: true,
      item: {
        revision: 1,
        title: "Deadlines",
        body: "The deadline is the fifteenth.",
        sourceClass: "user_direct",
        staleSince: null,
        containedClaimIds: [],
        linkTargets: [],
      },
    });
    const handle = ctx.handles.mint({ kind: "n", spaceId: US, nodeId: "n1" });
    const r = await memoryOpen({ handle, ctx });
    expect(r).toMatchObject({ status: "opened", kind: "note" });
    expect(taint.seen()).toBe(false);
  });

  it("nor does a refused document read - nothing was handed back", async () => {
    const { ctx, taint } = ctxWith();
    openSourceForModel.mockResolvedValue({ ok: false, reason: "not_found" });
    const handle = ctx.handles.mint({ kind: "f", spaceId: US, nodeId: "gone" });
    expect(await memoryOpen({ handle, ctx })).toMatchObject({ status: "not_found" });
    expect(taint.seen()).toBe(false);
  });
});
