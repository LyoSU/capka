import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], args: [] as Record<string, unknown>[] }));

vi.mock("@/lib/mcp/service", () => ({
  upsertServer: async (i: Record<string, unknown>) => { h.calls.push("upsertServer"); h.args.push(i); return "srv-remote"; },
  upsertStdioServer: async (i: Record<string, unknown>) => { h.calls.push("upsertStdioServer"); h.args.push(i); return "srv-stdio"; },
  setEnabled: async (id: string, e: boolean) => { h.calls.push(`setEnabled(${id},${e})`); },
}));
vi.mock("@/lib/skills/service", () => ({
  ingestSkill: async (p: { name: string }) => { h.calls.push(`ingestSkill(${p.name})`); },
}));

import { applyPlanResources } from "../apply";
import { MANUAL } from "../fence";
import type { ReviewObservations } from "../observe";
import type { ResolvedPluginPlan } from "../plan";

const TARGET = { scope: "system" as const, userId: null, projectId: null };
/** Only `detectedAuth` reaches the writer; the rest of the observation exists for the
 *  review, so it is filled in as inert here rather than left out. */
const obs = (detectedAuth: Record<string, "token" | "oauth"> = {}): ReviewObservations =>
  ({ urls: {}, detectedAuth, policy: { blockPrivate: false }, observedAt: "2026-08-14T00:00:00.000Z" });
const TAG = "catalog:i1";

const basePlan = (over: Partial<ResolvedPluginPlan> = {}): ResolvedPluginPlan => ({
  commit: { sha: "c".repeat(40), date: null, message: null },
  connectors: [], skills: [], ignored: [], notes: [], files: [], needsFiles: false, ...over,
});

beforeEach(() => { h.calls.length = 0; h.args.length = 0; });

describe("applyPlanResources", () => {
  it("copies the plan's parse-derived fields into the manifest verbatim", async () => {
    const manifest = await applyPlanResources(
      basePlan({ version: "1.2.3", displayName: "Fx", ignored: [{ type: "agents", count: 2 }], notes: ["n1", "n2"] }),
      obs(), TAG, TARGET, MANUAL,
    );
    expect(manifest).toEqual({
      skills: [], connectors: [], ignored: [{ type: "agents", count: 2 }], notes: ["n1", "n2"],
      commit: { sha: "c".repeat(40), date: null, message: null }, version: "1.2.3", displayName: "Fx",
    });
  });

  it("installs every stdio connector disabled", async () => {
    await applyPlanResources(
      basePlan({ connectors: [{ name: "gh", originKey: "x#gh", kind: "stdio", command: "npx", args: ["gh"],
                                bundled: false, envUnresolved: false, hasPlaceholder: false }] }),
      obs(), TAG, TARGET, MANUAL,
    );
    expect(h.calls).toEqual(["upsertStdioServer", "setEnabled(srv-stdio,false)"]);
  });

  it("disables a remote connector only when it needs a key, and uses the observed auth kind", async () => {
    await applyPlanResources(
      basePlan({ connectors: [
        { name: "a", originKey: "x#a", kind: "remote", url: "https://a.example/mcp", headers: { K: "v" },
          bundled: false, envUnresolved: false, hasPlaceholder: false },
        { name: "b", originKey: "x#b", kind: "remote", url: "https://b.example/mcp", headers: { K: "${T}" },
          bundled: false, envUnresolved: false, hasPlaceholder: true },
      ] }),
      obs({ a: "oauth" }), TAG, TARGET, MANUAL,
    );
    expect(h.calls).toEqual(["upsertServer", "upsertServer", "setEnabled(srv-remote,false)"]);
    expect(h.args[0]).toMatchObject({ authKind: "oauth", secrets: { headers: { K: "v" } } });
    expect(h.args[1]).toMatchObject({ authKind: "token", secrets: undefined });
  });

  it("makes no network call of any kind", async () => {
    // The writer is the one step that must be safe to run inside a transaction, so it
    // may not reach the network. `fetch` throwing proves nothing tried.
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("the writer must not fetch"); }) as typeof fetch;
    try {
      await applyPlanResources(
        basePlan({ connectors: [{ name: "a", originKey: "x#a", kind: "remote", url: "https://a.example/mcp",
                                  bundled: false, envUnresolved: false, hasPlaceholder: false }] }),
        obs(), TAG, TARGET, MANUAL,
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(h.calls).toEqual(["upsertServer"]);
  });
});
