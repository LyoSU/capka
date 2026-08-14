import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ probe: vi.fn<(url: string) => Promise<"token" | "oauth">>() }));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: h.probe }));

import { observePluginPlan } from "../observe";
import type { ResolvedPluginPlan } from "../plan";

const plan = (connectors: ResolvedPluginPlan["connectors"]): ResolvedPluginPlan => ({
  commit: { sha: "c".repeat(40), date: null, message: null },
  connectors, skills: [], ignored: [], notes: [], files: [], needsFiles: false,
});

const remote = (name: string, url: string) => ({
  name, originKey: `.mcp.json#${name}`, kind: "remote" as const, url,
  bundled: false, envUnresolved: false, hasPlaceholder: false,
});

beforeEach(() => h.probe.mockReset());

describe("observePluginPlan", () => {
  it("probes every remote connector and keys the result by name", async () => {
    h.probe.mockResolvedValueOnce("oauth").mockResolvedValueOnce("token");
    const obs = await observePluginPlan(plan([remote("a", "https://a.example/mcp"), remote("b", "https://b.example/mcp")]));
    expect(obs.detectedAuth).toEqual({ a: "oauth", b: "token" });
  });

  it("does not probe a stdio connector — there is no URL to probe", async () => {
    await observePluginPlan(plan([
      { name: "gh", originKey: ".mcp.json#gh", kind: "stdio", command: "npx",
        bundled: false, envUnresolved: false, hasPlaceholder: false },
    ]));
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("degrades a failed probe to `token` instead of aborting the plan", async () => {
    h.probe.mockRejectedValueOnce(new Error("DNS is down"));
    const obs = await observePluginPlan(plan([remote("a", "https://a.example/mcp")]));
    expect(obs.detectedAuth).toEqual({ a: "token" });
  });
});
