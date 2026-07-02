import { describe, it, expect } from "vitest";
import { makeAskTool } from "../tool";

describe("makeAskTool", () => {
  it("exposes an `ask` tool with an input schema and NO execute", () => {
    const { ask } = makeAskTool();
    expect(ask).toBeTruthy();
    expect(ask.inputSchema).toBeTruthy();
    // No execute → the AI SDK tool-loop stops the run when the model calls it.
    expect(ask.execute).toBeUndefined();
    expect(ask.needsApproval).toBeUndefined();
  });
});
