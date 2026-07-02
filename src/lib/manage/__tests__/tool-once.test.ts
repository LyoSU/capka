import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { makeManageTool } from "../tool";
import type { ManageResult } from "../types";

// The runner re-streams the SAME model messages on a capability/stall retry; for an
// approved-then-executing `manage` call that means the AI SDK runs `execute` AGAIN
// with the SAME toolCallId. Before the fix that double-applied a mutation (the
// "created twice" bug). `execute` must now run at most once per toolCallId per task
// tool instance. `capabilities` is read-only (no DB), so it exercises the memo path
// without a database.
const opts = (toolCallId: string) => ({ toolCallId, messages: [] as ModelMessage[] });
type Exec = (args: { action: string }, o: ReturnType<typeof opts>) => Promise<ManageResult>;

describe("makeManageTool exactly-once execution", () => {
  it("returns the SAME result for a repeated toolCallId (no re-run)", async () => {
    const execute = makeManageTool({ userId: "u1", isAdmin: false, projectId: null }).manage.execute as Exec;
    const first = await execute({ action: "capabilities" }, opts("call-1"));
    const again = await execute({ action: "capabilities" }, opts("call-1"));
    expect(again).toBe(first); // identical reference — dispatch ran only once
  });

  it("runs independently for different toolCallIds", async () => {
    const execute = makeManageTool({ userId: "u1", isAdmin: false, projectId: null }).manage.execute as Exec;
    const a = await execute({ action: "capabilities" }, opts("call-1"));
    const b = await execute({ action: "capabilities" }, opts("call-2"));
    expect(b).not.toBe(a); // a fresh call → a fresh dispatch
  });

  it("scopes the memo per tool instance (a new task can run the same call id)", async () => {
    const t1 = makeManageTool({ userId: "u1", isAdmin: false, projectId: null }).manage.execute as Exec;
    const t2 = makeManageTool({ userId: "u1", isAdmin: false, projectId: null }).manage.execute as Exec;
    const a = await t1({ action: "capabilities" }, opts("call-1"));
    const b = await t2({ action: "capabilities" }, opts("call-1"));
    expect(b).not.toBe(a);
  });
});
