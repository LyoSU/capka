import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  probe: vi.fn<(url: string) => Promise<"token" | "oauth">>(),
  preflight: vi.fn<(url: string, blockPrivate: boolean) => Promise<string>>(),
}));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: h.probe }));
vi.mock("@/lib/net/ssrf", () => ({ preflightUrl: h.preflight }));

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

const OPEN = { blockPrivate: false };

beforeEach(() => {
  h.probe.mockReset();
  h.preflight.mockReset().mockResolvedValue("allowed");
});

describe("observePluginPlan", () => {
  it("probes every remote connector and keys the result by name", async () => {
    h.probe.mockResolvedValueOnce("oauth").mockResolvedValueOnce("token");
    const obs = await observePluginPlan(plan([remote("a", "https://a.example/mcp"), remote("b", "https://b.example/mcp")]), OPEN);
    expect(obs.detectedAuth).toEqual({ a: "oauth", b: "token" });
    expect(obs.urls).toEqual({ a: "allowed", b: "allowed" });
  });

  it("does not probe a stdio connector — there is no URL to probe", async () => {
    await observePluginPlan(plan([
      { name: "gh", originKey: ".mcp.json#gh", kind: "stdio", command: "npx",
        bundled: false, envUnresolved: false, hasPlaceholder: false },
    ]), OPEN);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.preflight).not.toHaveBeenCalled();
  });

  it("degrades a failed probe to `token` instead of aborting the plan", async () => {
    h.probe.mockRejectedValueOnce(new Error("DNS is down"));
    const obs = await observePluginPlan(plan([remote("a", "https://a.example/mcp")]), OPEN);
    expect(obs.detectedAuth).toEqual({ a: "token" });
  });

  it("does not probe an unsafe URL at all", async () => {
    // Asking a blocked address about its auth metadata would BE the SSRF the preflight
    // just refused — a probe is a request, and this one would reach cloud metadata.
    h.preflight.mockResolvedValue("blocked");
    const obs = await observePluginPlan(plan([remote("meta", "http://169.254.169.254/mcp")]), OPEN);
    expect(h.probe).not.toHaveBeenCalled();
    expect(obs.urls).toEqual({ meta: "blocked" });
    expect(obs.detectedAuth).toEqual({ meta: "token" });
  });

  it("records the policy the verdicts were computed under", async () => {
    // The same URL is allowed on one instance and refused on another, so a verdict
    // without its policy cannot be interpreted — or re-verified at apply time.
    const obs = await observePluginPlan(plan([remote("a", "https://a.example/mcp")]), { blockPrivate: true });
    expect(obs.policy).toEqual({ blockPrivate: true });
    expect(h.preflight).toHaveBeenCalledWith("https://a.example/mcp", true);
  });

  it("resolves one URL once even when two connectors share it", async () => {
    const obs = await observePluginPlan(
      plan([remote("a", "https://one.example/mcp"), remote("b", "https://one.example/mcp")]), OPEN);
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(obs.urls).toEqual({ a: "allowed", b: "allowed" });
  });

  it("timestamps the observation for display", async () => {
    const obs = await observePluginPlan(plan([]), OPEN);
    expect(Date.parse(obs.observedAt)).not.toBeNaN();
  });
});
