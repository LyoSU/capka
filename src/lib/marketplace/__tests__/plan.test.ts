import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: { tree: [] as { path: string; type: "blob" | "tree"; sha: string }[], files: {} as Record<string, string> },
}));

vi.mock("../fetch", () => ({
  ghFetch: async () => (() => { throw new Error("no network"); }) as unknown as typeof fetch,
  resolveCommit: async () => ({ sha: "c".repeat(40), date: null, message: null }),
  ghTree: async () => h.state.tree,
  ghRaw: async (_o: string, _r: string, _s: string, path: string) => h.state.files[path] ?? null,
  diffTrees: vi.fn(),
}));

import { buildPluginPlan } from "../plan";

const GH = { owner: "acme", repo: "plug", ref: "main", subdir: "" };

function load(files: Record<string, string>) {
  h.state.files = files;
  h.state.tree = Object.keys(files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
}

describe("buildPluginPlan", () => {
  it("describes a remote connector without touching the network beyond the tree", async () => {
    load({
      ".mcp.json": JSON.stringify({
        mcpServers: { api: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${T}" } } },
      }),
    });

    const plan = await buildPluginPlan(GH);

    expect(plan.connectors).toEqual([
      {
        name: "api",
        originKey: ".mcp.json#api",
        kind: "remote",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer ${T}" },
        hasPlaceholder: true,
        bundled: false,
        envUnresolved: false,
      },
    ]);
    // The note lives in `plan.notes`, not on the connector: its ORDER is behaviour,
    // so it must have exactly one home.
    expect(plan.notes).toEqual(["api: needs an access key — open Connectors to add it"]);
    expect(plan.needsFiles).toBe(false);
    expect(plan.files).toEqual([]);
  });

  it("is reproducible: two builds of one SHA are deeply equal", async () => {
    load({ ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["gh"] } } }) });
    const a = await buildPluginPlan(GH);
    const b = await buildPluginPlan(GH);
    expect(a).toEqual(b);
  });

  it("records no connectors when `only` narrows to skills", async () => {
    load({
      ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx" } } }),
      "skills/writer/SKILL.md": "---\nname: writer\n---\nBody",
    });
    const plan = await buildPluginPlan(GH, ["writer"]);
    expect(plan.connectors).toEqual([]);
    expect(plan.skills.map((s) => s.name)).toEqual(["writer"]);
  });
});

describe("properties the later phases rely on", () => {
  it("builds a plan without any write path in scope", async () => {
    // plan.ts must not import a service that writes. Enforced by inspection rather
    // than mocking: a mock proves nothing was CALLED, this proves nothing was WIRED.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../plan.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/@\/lib\/mcp\/service/);
    expect(src).not.toMatch(/@\/lib\/skills\/service/);
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/oauth\/detect/);
  });

  it("keeps note order stable across the three sources", async () => {
    load({
      ".claude-plugin/plugin.json": JSON.stringify({ mcpServers: ["cfg/missing.json"] }),
      ".mcp.json": "{ broken",
    });
    const plan = await buildPluginPlan(GH);
    expect(plan.notes[0]).toBe("cfg/missing.json: referenced MCP config not found");
    expect(plan.notes[1]).toMatch(/^\.mcp\.json could not be read: /);
  });

  it("gives every routed connector an originKey naming its source file", async () => {
    load({ ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx" } } }) });
    const plan = await buildPluginPlan(GH);
    expect(plan.connectors[0].originKey).toBe(".mcp.json#gh");
  });
});
