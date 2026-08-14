import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Behaviour-neutrality net for the Phase A split of `applyPlugin`
 * (docs/plugin-install-review-spec.md §12a). Each fixture pins THREE things:
 * the returned manifest, the bundled files, and the ORDERED journal of writer
 * calls — an identical manifest does not prove identical writes, which is the
 * regression a refactor of this function would otherwise hide.
 */
const h = vi.hoisted(() => ({
  state: {
    tree: [] as { path: string; type: "blob" | "tree"; sha: string }[],
    files: {} as Record<string, string>,
    authKind: "token" as "token" | "oauth",
  },
  calls: [] as string[],
  args: [] as Record<string, unknown>[],
}));

vi.mock("../fetch", () => ({
  ghFetch: async () => (() => {
    throw new Error("characterization fixtures must not reach the network");
  }) as unknown as typeof fetch,
  resolveCommit: async () => ({ sha: "c".repeat(40), date: "2026-01-01T00:00:00.000Z", message: "fixture" }),
  ghTree: async () => h.state.tree,
  ghRaw: async (_owner: string, _repo: string, _ref: string, path: string) => h.state.files[path] ?? null,
  diffTrees: vi.fn(),
}));
vi.mock("@/lib/mcp/oauth/detect", () => ({ detectAuthKind: async () => h.state.authKind }));
// Phase B gave `observePluginPlan` a DNS preflight. Pinned to `allowed` so these
// fixtures keep characterizing the SAME behaviour: the auth probe still runs, and no
// expectation below changes. An unmocked preflight would resolve fixture hostnames for
// real, which is both slow and non-deterministic.
vi.mock("@/lib/net/ssrf", () => ({ preflightUrl: async () => "allowed" }));
vi.mock("@/lib/mcp/service", () => ({
  upsertServer: async (input: Record<string, unknown>) => { h.calls.push("upsertServer"); h.args.push(input); return "srv-remote"; },
  upsertStdioServer: async (input: Record<string, unknown>) => { h.calls.push("upsertStdioServer"); h.args.push(input); return "srv-stdio"; },
  setEnabled: async (id: string, enabled: boolean) => { h.calls.push(`setEnabled(${id},${enabled})`); },
  deleteServer: vi.fn(),
}));
vi.mock("@/lib/skills/service", () => ({
  ingestSkill: async (parsed: { name: string }, files: unknown[]) => {
    h.calls.push(`ingestSkill(${parsed.name},${files.length})`);
  },
  deleteSkill: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    delete: () => ({ where: async () => {} }),
  },
}));

import { applyPlanResources } from "../apply";
import { observePluginPlan } from "../observe";
import { buildPluginPlan } from "../plan";

const GH = { owner: "acme", repo: "plug", ref: "main", subdir: "" };
const TARGET = { scope: "system" as const, userId: null, projectId: null };
const TAG = "catalog:inst1";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Load a fixture tree + file map, then run the three functions the way the callers
 *  do. Every expectation below is byte-identical to the version that ran against the
 *  single `applyPlugin` — that equality is the whole point of this file. */
async function runFixture(
  files: Record<string, string>,
  only?: string[],
  authKind: "token" | "oauth" = "token",
) {
  h.state.files = files;
  h.state.tree = Object.keys(files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
  h.state.authKind = authKind;
  const plan = await buildPluginPlan(GH, only);
  const obs = await observePluginPlan(plan, { blockPrivate: false });
  const manifest = await applyPlanResources(plan, obs, TAG, TARGET);
  return { manifest, files: plan.files };
}

beforeEach(() => {
  h.calls.length = 0;
  h.args.length = 0;
});

describe("remote connector with a placeholder header", () => {
  const FILES = {
    ".mcp.json": JSON.stringify({
      mcpServers: { api: { url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } },
    }),
  };

  it("routes it, installs it disabled, and does not persist the header", async () => {
    const { manifest, files } = await runFixture(FILES);

    expect(manifest.connectors).toEqual(["api"]);
    expect(manifest.skills).toEqual([]);
    expect(manifest.ignored).toEqual([]);
    expect(manifest.notes).toEqual(["api: needs an access key — open Connectors to add it"]);
    expect(manifest.commit).toEqual({ sha: "c".repeat(40), date: "2026-01-01T00:00:00.000Z", message: "fixture" });
    expect(files).toEqual([]);

    expect(h.calls).toEqual(["upsertServer", "setEnabled(srv-remote,false)"]);
    expect(h.args[0]).toMatchObject({
      name: "api",
      url: "https://api.example.com/mcp",
      authKind: "token",
      source: TAG,
      scope: "system",
      // The placeholder means the header set is NOT persisted — the names are lost
      // today, which is why the spec reconstructs `sourceBefore` from the old SHA.
      secrets: undefined,
    });
  });

  it("carries the probed auth kind through to the row", async () => {
    await runFixture(FILES, undefined, "oauth");
    expect(h.args[0]).toMatchObject({ authKind: "oauth" });
  });
});

describe("remote connector without a placeholder", () => {
  it("persists the headers and leaves the connector enabled", async () => {
    const { manifest } = await runFixture({
      ".mcp.json": JSON.stringify({
        mcpServers: { api: { url: "https://api.example.com/mcp", headers: { "X-Key": "literal" } } },
      }),
    });

    expect(manifest.notes).toEqual([]);
    expect(h.calls).toEqual(["upsertServer"]); // no setEnabled — this one stays on
    expect(h.args[0]).toMatchObject({ secrets: { headers: { "X-Key": "literal" } } });
  });
});

describe("stdio connector, bare command", () => {
  it("installs disabled with the third-party-code note and bundles no files", async () => {
    const { manifest, files } = await runFixture({
      ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "@x/gh-mcp"] } } }),
    });

    expect(manifest.connectors).toEqual(["gh"]);
    expect(manifest.notes).toEqual([
      "gh: runs third-party code in your sandbox — review and enable it in Extensions",
    ]);
    expect(files).toEqual([]);
    expect(h.calls).toEqual(["upsertStdioServer", "setEnabled(srv-stdio,false)"]);
    expect(h.args[0]).toMatchObject({ name: "gh", command: "npx", args: ["-y", "@x/gh-mcp"], source: TAG });
  });
});

describe("stdio connector referencing the plugin root", () => {
  it("bundles EVERY eligible blob, not just the entrypoint", async () => {
    // selectPluginFiles takes every blob under the prefix except skills/ and
    // node_modules/ — so `.mcp.json` itself is bundled too. Asserting only
    // `servers/run.js` here would pass a refactor that silently narrowed the set.
    const mcp = JSON.stringify({
      mcpServers: { local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/servers/run.js"] } },
    });
    const { manifest, files } = await runFixture({ ".mcp.json": mcp, "servers/run.js": "console.log(1)" });

    expect(manifest.notes).toEqual([
      "local: ships code that runs in users' sandboxes — review and enable it in Extensions",
    ]);
    expect(files).toEqual([
      { path: ".mcp.json", content: b64(mcp) },
      { path: "servers/run.js", content: b64("console.log(1)") },
    ]);
    expect(h.calls).toEqual(["upsertStdioServer", "setEnabled(srv-stdio,false)"]);
  });
});

describe("stdio connector with an unresolved env placeholder", () => {
  it("reports the configuration note instead of the code-runs note", async () => {
    const { manifest } = await runFixture({
      ".mcp.json": JSON.stringify({
        mcpServers: { db: { command: "uvx", args: ["db-mcp"], env: { DSN: "${DSN}" } } },
      }),
    });
    expect(manifest.notes).toEqual(["db: needs configuration — open Connectors to finish"]);
  });
});

describe("name-clash precedence", () => {
  it("resolves inline < referenced config < root .mcp.json", async () => {
    const { manifest } = await runFixture({
      ".claude-plugin/plugin.json": JSON.stringify({
        version: "2.1.0",
        displayName: "Fixture Plugin",
        mcpServers: [{ dup: { url: "https://inline.example/mcp" } }, "cfg/extra.json"],
      }),
      "cfg/extra.json": JSON.stringify({ mcpServers: { dup: { url: "https://referenced.example/mcp" } } }),
      ".mcp.json": JSON.stringify({ mcpServers: { dup: { url: "https://root.example/mcp" } } }),
    });

    expect(manifest.version).toBe("2.1.0");
    expect(manifest.displayName).toBe("Fixture Plugin");
    expect(manifest.connectors).toEqual(["dup"]);
    expect(h.args[0]).toMatchObject({ url: "https://root.example/mcp" });
  });
});

describe("skills and commands", () => {
  it("ingests SKILL.md with its sibling files, then commands, in tree order", async () => {
    const { manifest } = await runFixture({
      "skills/writer/SKILL.md": "---\nname: writer\ndescription: writes\n---\nBody",
      "skills/writer/tpl.md": "template",
      "commands/summarize.md": "---\nname: summarize\n---\nSummarize it",
    });

    expect(manifest.skills).toEqual(["writer", "summarize"]);
    expect(h.calls).toEqual(["ingestSkill(writer,1)", "ingestSkill(summarize,0)"]);
  });

  it("falls back to the filename when a command has no frontmatter name", async () => {
    const { manifest } = await runFixture({ "commands/tidy.md": "Just a body" });
    expect(manifest.skills).toEqual(["tidy"]);
  });
});

describe("`only` narrowing", () => {
  it("routes NO connectors and filters skills by name", async () => {
    const { manifest } = await runFixture(
      {
        ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["gh"] } } }),
        "skills/writer/SKILL.md": "---\nname: writer\n---\nBody",
        "skills/other/SKILL.md": "---\nname: other\n---\nBody",
      },
      ["writer"],
    );

    expect(manifest.connectors).toEqual([]);
    expect(manifest.skills).toEqual(["writer"]);
    expect(h.calls).toEqual(["ingestSkill(writer,0)"]);
  });
});

describe("malformed and unusable input", () => {
  it("notes a referenced config that is missing from the tree", async () => {
    const { manifest } = await runFixture({
      ".claude-plugin/plugin.json": JSON.stringify({ mcpServers: ["cfg/missing.json"] }),
    });
    expect(manifest.notes).toEqual(["cfg/missing.json: referenced MCP config not found"]);
  });

  it("notes an unparseable root .mcp.json and routes nothing", async () => {
    const { manifest } = await runFixture({ ".mcp.json": "{ not json" });
    expect(manifest.connectors).toEqual([]);
    expect(manifest.notes.length).toBe(1);
    expect(manifest.notes[0]).toMatch(/^\.mcp\.json could not be read: /);
    expect(h.calls).toEqual([]);
  });

  it("skips a server with neither command nor url", async () => {
    const { manifest } = await runFixture({ ".mcp.json": JSON.stringify({ mcpServers: { odd: { type: "http" } } }) });
    expect(manifest.notes).toEqual(["odd: no URL, skipped"]);
    expect(manifest.connectors).toEqual([]);
  });

  it("tolerates a malformed plugin.json without failing the install", async () => {
    const { manifest } = await runFixture({
      ".claude-plugin/plugin.json": "{ broken",
      ".mcp.json": JSON.stringify({ mcpServers: { gh: { command: "npx" } } }),
    });
    expect(manifest.version).toBeUndefined();
    expect(manifest.connectors).toEqual(["gh"]);
  });
});

describe("preserved-but-inactive directories", () => {
  it("counts them into `ignored` without routing anything", async () => {
    const { manifest } = await runFixture({ "agents/a.md": "x", "agents/b.md": "y", "hooks/h.json": "{}" });
    expect(manifest.ignored).toEqual([{ type: "agents", count: 2 }, { type: "hooks", count: 1 }]);
    expect(h.calls).toEqual([]);
  });
});

describe("bundled-file caps", () => {
  // MAX_PLUGIN_FILE_BYTES = 1_000_000 skips ONE file and keeps going;
  // MAX_PLUGIN_TOTAL_BYTES = 5_000_000 stops the loop entirely. The two produce
  // different notes and different survivors, so both are pinned.
  const bundledMcp = JSON.stringify({
    mcpServers: { local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/run.js"] } },
  });

  it("skips a single oversized file and continues with the rest", async () => {
    const { manifest, files } = await runFixture({
      ".mcp.json": bundledMcp,
      "big.bin": "x".repeat(1_000_001),
      "run.js": "ok",
    });

    expect(manifest.notes).toEqual([
      "local: ships code that runs in users' sandboxes — review and enable it in Extensions",
      "big.bin: file too large, skipped",
    ]);
    expect(files.map((f) => f.path)).toEqual([".mcp.json", "run.js"]);
  });

  it("stops at the total cap and says some files were skipped", async () => {
    const { manifest, files } = await runFixture({
      ".mcp.json": bundledMcp,
      "a.bin": "x".repeat(900_000),
      "b.bin": "x".repeat(900_000),
      "c.bin": "x".repeat(900_000),
      "d.bin": "x".repeat(900_000),
      "e.bin": "x".repeat(900_000),
      "f.bin": "x".repeat(900_000),
      "run.js": "ok",
    });

    expect(manifest.notes.at(-1)).toBe("plugin files exceed the size cap; some were skipped");
    // The loop BREAKS, so nothing after the offending entry is bundled — including
    // `run.js`, the entrypoint. Pinning this stops a refactor from silently
    // switching `break` to `continue` and changing which files reach the sandbox.
    expect(files.map((f) => f.path)).toEqual([".mcp.json", "a.bin", "b.bin", "c.bin", "d.bin", "e.bin"]);
  });
});
