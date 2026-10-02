import { describe, it, expect, vi } from "vitest";
import { NATIVE_TOOL_NAMES, isKnownToolName } from "../native-tools";

// The vault factory resolves its spaces up front; nothing else it does at build time
// touches the database.
vi.mock("@/lib/vault/spaces", () => ({ getOrCreateSpace: async () => "space-1" }));

import { loadSandboxTools } from "@/lib/sandbox/tools";
import { makeViewFileTool } from "@/lib/sandbox/view-file";
import { makePlanTool } from "@/lib/chat/plan-tool";
import { makeSkillTool } from "@/lib/skills/tool";
import { makeManageTool } from "@/lib/manage/tool";
import { makeAskTool } from "@/lib/ask/tool";
import { makeQuietTool } from "@/lib/automations/quiet-tool";
import { makeVaultMemoryTools } from "@/lib/vault/tools";
import { makeVaultBudget } from "@/lib/vault/budget";
import { makeHandleMap } from "@/lib/vault/handles";
import { makeTurnTaint } from "@/lib/tasks/turn-taint";
import { providerNativeTools } from "@/lib/providers";
import { FIND_TOOL_NAME } from "@/lib/mcp/tool-search";

describe("NATIVE_TOOL_NAMES", () => {
  it("lists every tool prepareRun's factories register, and nothing else", async () => {
    const ensureSession = async () => ({});
    const registered = [
      ...Object.keys((await loadSandboxTools("s", "u", ensureSession)).tools),
      ...Object.keys(makeViewFileTool({ sessionKey: "s", userId: "u", ensureSession, emitImageToolResult: true })),
      ...Object.keys(makePlanTool()),
      ...Object.keys({ skill: makeSkillTool({ userId: "u", sessionKey: "s", projectId: null, effectFor: () => "allow" }) }),
      ...Object.keys(makeManageTool({ userId: "u", isAdmin: true, projectId: null })),
      ...Object.keys(makeAskTool()),
      ...Object.keys(makeQuietTool({ automationId: "a", notifyMode: "when_needed" }, {})),
      ...Object.keys(await makeVaultMemoryTools({
        userId: "u", messageId: "m", taskId: "t", userTurnText: "",
        handles: makeHandleMap(), budget: makeVaultBudget(), taint: makeTurnTaint({ messageId: "m", seeded: false, write: async () => {} }),
      })),
      ...Object.keys(providerNativeTools("google")),
      FIND_TOOL_NAME,
    ];
    expect(registered.filter((n) => !isKnownToolName(n))).toEqual([]);
    expect([...registered].sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
  });

  it("knows connector tools by their prefix", () => {
    expect(isKnownToolName("mcp__firecrawl__firecrawl_search")).toBe(true);
    expect(isKnownToolName("default_api")).toBe(false);
  });
});
