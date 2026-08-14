# Plugin install review — Phase A implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `applyPlugin` into an artifact-only parser, a network-observation step, and the single writer — with characterization tests proving the split changes no behaviour.

**Architecture:** `applyPlugin` currently interleaves three concerns: it fetches and parses a plugin's tree, probes a remote URL for OAuth support, and upserts rows — all inside one function whose `routeServer` closure mutates a shared `manifest`. Phase A cuts it into `buildPluginPlan` (fetch + parse → a plain data structure, no probes, no writes), `observePluginPlan` (the existing `detectAuthKind` call, relocated), and `applyPlanResources` (every write). A characterization suite is written **first**, against today's code, and must keep passing unchanged through every step.

**Tech Stack:** TypeScript, Vitest 4, Drizzle ORM, Next.js. No new dependencies.

**Spec:** `docs/plugin-install-review-spec.md` — §5 (function contract), §12a (phasing), §12 (test matrix, rows "Characterization of `buildPluginPlan`" and "Characterization of `observePluginPlan`").

## Global Constraints

- **No behaviour change.** Phase A relocates code. Nothing user-visible changes, no new network call is introduced, and no message text is edited. `preflightUrl` belongs to Phase B and must NOT appear here.
- **`InstallManifest` keeps its exact shape** (`src/lib/marketplace/types.ts`). It stays the output of the writer so `installPlugin`, `upgradePlugin`, `pruneRemoved`, the plugins UI and the audit trail need no adjustment beyond the call sequence in Task 5.
- **Order is behaviour.** `manifest.notes`, `manifest.connectors`, `manifest.skills` and the bundled `files` array are all order-sensitive, and the characterization tests assert exact arrays. Preserve emission order when moving code.
- **`only` semantics are load-bearing:** when `only` is set, connectors are not routed at all (`if (!onlySet)` at `install.ts:194`). Preserve exactly.
- **Every stdio connector is installed disabled** (`setEnabled(sid, false)`, unconditional). A remote connector is disabled only when its headers carry a `${` placeholder. Preserve exactly.
- Run `npx tsc --noEmit`, `npm run lint` and `npm test` before each commit. Commits go straight to `master` (see `CLAUDE.md`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/marketplace/plan.ts` (new) | `ResolvedPluginPlan`, `PlannedConnector`, `PlannedSkill` types and `buildPluginPlan` — fetch + parse only |
| `src/lib/marketplace/observe.ts` (new) | `ReviewObservations` and `observePluginPlan` — the network probes |
| `src/lib/marketplace/apply.ts` (new) | `applyPlanResources` — the only writer |
| `src/lib/marketplace/install.ts` (modify) | loses `applyPlugin`; `installPlugin` / `upgradePlugin` orchestrate the three calls |
| `src/lib/marketplace/__tests__/apply-characterization.test.ts` (new) | fixtures + writer-call journal; the safety net for the whole phase |

Three files rather than one because their determinism differs: `plan.ts` is reproducible from a SHA, `observe.ts` is not, `apply.ts` is the only module that may write. That boundary is the deliverable, so it is visible in the file layout.

---

### Task 1: Characterization suite against today's `applyPlugin`

The safety net must exist and pass **before** any code moves. It captures three things per fixture: the returned `InstallManifest`, the bundled `files` array, and the ordered journal of writer calls — because identical manifests do not prove identical writes.

**Files:**
- Modify: `src/lib/marketplace/install.ts:117` (export `applyPlugin` temporarily)
- Test: `src/lib/marketplace/__tests__/apply-characterization.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the fixture harness (`h.state`, `h.calls`, `h.args`, `runFixture`) that Tasks 2–6 re-point at the new functions. No production interface.

- [ ] **Step 1: Export `applyPlugin` for the test**

In `src/lib/marketplace/install.ts`, change the declaration (currently `async function applyPlugin(`):

```typescript
/** Exported ONLY for the characterization suite that guards the Phase A split
 *  (docs/plugin-install-review-plan-phase-a.md). Deleted in Task 5 along with the
 *  function itself — no production caller outside this module. */
export async function applyPlugin(
```

- [ ] **Step 2: Write the failing test file**

Create `src/lib/marketplace/__tests__/apply-characterization.test.ts`:

```typescript
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
vi.mock("@/lib/mcp/service", () => ({
  upsertServer: async (input: Record<string, unknown>) => { h.calls.push("upsertServer"); h.args.push(input); return "srv-remote"; },
  upsertStdioServer: async (input: Record<string, unknown>) => { h.calls.push("upsertStdioServer"); h.args.push(input); return "srv-stdio"; },
  setEnabled: async (id: string, enabled: boolean) => { h.calls.push(`setEnabled(${id},${enabled})`); },
  deleteServer: vi.fn(),
}));
vi.mock("@/lib/skills/service", () => ({
  ingestSkill: async (parsed: { name: string }, files: unknown[]) => {
    h.calls.push(`ingestSkill(${parsed.name},${(files as unknown[]).length})`);
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

import { applyPlugin } from "../install";

const GH = { owner: "acme", repo: "plug", ref: "main", subdir: "" };
const TARGET = { scope: "system" as const, userId: null, projectId: null };
const TAG = "catalog:inst1";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Load a fixture tree + file map, then run the function under test. */
async function runFixture(
  files: Record<string, string>,
  only?: string[],
  authKind: "token" | "oauth" = "token",
) {
  h.state.files = files;
  h.state.tree = Object.keys(files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
  h.state.authKind = authKind;
  return applyPlugin(GH, TAG, TARGET, only);
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
```

The spec's characterization row also lists `rename`. There is nothing to characterize
about a rename in Phase A: a rename is a difference between two surfaces, and no
surface or delta exists until Phase B. It is covered by the delta tests there, not here.

- [ ] **Step 3: Run it and confirm every fixture passes against the current code**

Run: `npx vitest run src/lib/marketplace/__tests__/apply-characterization.test.ts`
Expected: PASS. These describe today's behaviour — a failure here means a fixture expectation is wrong, not that the code is. Fix the fixture, never the source, in this task.

- [ ] **Step 4: Verify the suite has teeth**

Temporarily delete the `await setEnabled(sid, false);` line at `install.ts:148`, re-run, and confirm the stdio fixtures FAIL on the writer journal. Restore the line and re-run to green. A net that cannot detect a removed write would not protect the refactor.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketplace/install.ts src/lib/marketplace/__tests__/apply-characterization.test.ts
git commit -m "test(marketplace): characterize applyPlugin before splitting it

Pins the returned manifest, the bundled file set and the ordered journal of writer
calls for fourteen fixtures. An identical manifest does not prove identical writes,
which is the regression a refactor of this function would otherwise hide."
```

---

### Task 2: `buildPluginPlan` — the artifact-only parser

**Files:**
- Create: `src/lib/marketplace/plan.ts`
- Modify: `src/lib/marketplace/install.ts` (`applyPlugin` consumes the plan; parsing moves out)
- Test: `src/lib/marketplace/__tests__/plan.test.ts` (create)

**Interfaces:**
- Consumes: `TreeEntry`, `CommitInfo` (`./fetch`, `./types`), `ServerDef`, `extractServers`, `parseManifestMcp` (`./manifest`), `refsPluginRoot`, `serverDefParts`, `hasUnresolvedPlaceholder`, `selectPluginFiles` (`./plugin-root`), `parseSkillMarkdown` (`@/lib/skills/parse`).
- Produces:
  ```typescript
  buildPluginPlan(gh: GitHubRef, only?: string[]): Promise<ResolvedPluginPlan>
  ```
  with the types below. Tasks 3–5 consume `ResolvedPluginPlan`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/marketplace/__tests__/plan.test.ts`:

```typescript
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
        note: "api: needs an access key — open Connectors to add it",
      },
    ]);
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/marketplace/__tests__/plan.test.ts`
Expected: FAIL — `Failed to resolve import "../plan"`.

- [ ] **Step 3: Create `plan.ts`**

```typescript
import { ghFetch, ghRaw, ghTree, resolveCommit, type TreeEntry } from "./fetch";
import { extractServers, parseManifestMcp, type ServerDef } from "./manifest";
import { hasUnresolvedPlaceholder, refsPluginRoot, selectPluginFiles, serverDefParts } from "./plugin-root";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import type { CommitInfo, GitHubRef } from "./types";

const IGNORED_DIRS = ["agents", "hooks", "lspServers", "outputStyles"];
const MAX_SKILL_FILES = 50;
const MAX_PLUGIN_FILES = 200;
const MAX_PLUGIN_FILE_BYTES = 1_000_000;
const MAX_PLUGIN_TOTAL_BYTES = 5_000_000;

/** One connector the install would create, described but not created. Carries no
 *  note: the note is derived from the same definition but belongs to `plan.notes`,
 *  whose ORDER is behaviour — duplicating it here would give two sources of truth. */
export interface PlannedConnector {
  name: string;
  /** Where this definition came from, `<manifest path>#<server key>`. Identity WITHIN
   *  one commit only: the server name IS the object key, so a rename changes it. */
  originKey: string;
  kind: "stdio" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bundled: boolean;
  envUnresolved: boolean;
  hasPlaceholder: boolean;
}

export interface PlannedSkill {
  name: string;
  parsed: ReturnType<typeof parseSkillMarkdown>;
  files: { path: string; content: string }[];
}

/** Everything an install would do, as data. Reproducible from `gh.ref` alone: no
 *  probe runs here, so two builds of one SHA are deeply equal. */
export interface ResolvedPluginPlan {
  commit: CommitInfo;
  version?: string;
  displayName?: string;
  connectors: PlannedConnector[];
  skills: PlannedSkill[];
  ignored: { type: string; count: number }[];
  /** Parse-derived notes in emission order: referenced-config failures, then root
   *  `.mcp.json` failures, then per-connector notes, then bundled-file caps. */
  notes: string[];
  files: { path: string; content: string }[];
  needsFiles: boolean;
}

export async function buildPluginPlan(gh: GitHubRef, only?: string[]): Promise<ResolvedPluginPlan> {
  const onlySet = only && only.length ? new Set(only) : null;
  const prefix = gh.subdir ? `${gh.subdir}/` : "";
  const fetchFn = await ghFetch();
  const commit = await resolveCommit(gh.owner, gh.repo, gh.ref, fetchFn);
  const tree = await ghTree(gh.owner, gh.repo, commit.sha, fetchFn);
  const raw = (path: string) => ghRaw(gh.owner, gh.repo, commit.sha, path, fetchFn);

  const notes: string[] = [];
  const connectors: PlannedConnector[] = [];
  const skills: PlannedSkill[] = [];
  const ignored: { type: string; count: number }[] = [];
  let version: string | undefined;
  let displayName: string | undefined;
  let needsFiles = false;

  let inlineServers: Record<string, ServerDef> = {};
  let manifestPaths: string[] = [];
  const pjPath = `${prefix}.claude-plugin/plugin.json`;
  if (tree.some((t) => t.path === pjPath)) {
    try {
      const pj = JSON.parse((await raw(pjPath)) ?? "{}") as Record<string, unknown>;
      if (typeof pj.version === "string") version = pj.version;
      if (typeof pj.displayName === "string") displayName = pj.displayName;
      if (pj.mcpServers != null) {
        const parsed = parseManifestMcp(pj.mcpServers);
        inlineServers = parsed.inline;
        manifestPaths = parsed.paths;
      }
    } catch { /* tolerate a malformed manifest */ }
  }

  const origin = new Map<string, string>();
  for (const name of Object.keys(inlineServers)) origin.set(name, ".claude-plugin/plugin.json#" + name);

  const pathServers: Record<string, ServerDef> = {};
  for (const rel of manifestPaths) {
    const full = `${prefix}${rel}`;
    if (!tree.some((t) => t.path === full)) { notes.push(`${rel}: referenced MCP config not found`); continue; }
    try {
      const txt = await raw(full);
      const found = extractServers(txt ? JSON.parse(txt) : {});
      for (const name of Object.keys(found)) origin.set(name, `${rel}#${name}`);
      Object.assign(pathServers, found);
    } catch (e) {
      notes.push(`${rel} could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  let fileServers: Record<string, ServerDef> = {};
  if (tree.some((t) => t.path === `${prefix}.mcp.json`)) {
    try {
      const mcpRaw = await raw(`${prefix}.mcp.json`);
      fileServers = extractServers(mcpRaw ? JSON.parse(mcpRaw) : {});
      for (const name of Object.keys(fileServers)) origin.set(name, `.mcp.json#${name}`);
    } catch (e) {
      notes.push(`.mcp.json could not be read: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  // Precedence on a name clash: inline < referenced config < root .mcp.json.
  const servers = { ...inlineServers, ...pathServers, ...fileServers };
  if (!onlySet) {
    for (const [sname, def] of Object.entries(servers)) {
      const result = planConnector(sname, origin.get(sname) ?? `#${sname}`, def);
      if (!result) continue;
      if ("skipped" in result) { notes.push(result.skipped); continue; }
      if (result.note) notes.push(result.note);
      if (result.routed.bundled) needsFiles = true;
      connectors.push(result.routed);
    }
  }

  const skillMds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}skills/`) && t.path.endsWith("/SKILL.md"));
  for (const md of skillMds) {
    const dir = md.path.slice(0, -"/SKILL.md".length);
    const body = await raw(md.path);
    if (!body) continue;
    let parsed;
    try { parsed = parseSkillMarkdown(body); } catch { continue; }
    if (!parsed.name) continue;
    if (onlySet && !onlySet.has(parsed.name)) continue;
    const files: { path: string; content: string }[] = [];
    const sibs = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path !== md.path).slice(0, MAX_SKILL_FILES);
    for (const f of sibs) {
      const content = await raw(f.path);
      if (content == null) continue;
      files.push({ path: f.path.slice(dir.length + 1), content: Buffer.from(content, "utf8").toString("base64") });
    }
    skills.push({ name: parsed.name, parsed, files });
  }

  const cmds = tree.filter((t) => t.type === "blob" && t.path.startsWith(`${prefix}commands/`) && t.path.endsWith(".md"));
  for (const c of cmds) {
    const body = await raw(c.path);
    if (!body) continue;
    let parsed: ReturnType<typeof parseSkillMarkdown> | null = null;
    try { parsed = parseSkillMarkdown(body); } catch { parsed = null; }
    const base = c.path.split("/").pop()!.replace(/\.md$/, "");
    const finalParsed = parsed && parsed.name ? parsed : { name: base, description: undefined, body, frontmatter: {} };
    if (onlySet && !onlySet.has(finalParsed.name)) continue;
    skills.push({ name: finalParsed.name, parsed: finalParsed, files: [] });
  }

  for (const d of IGNORED_DIRS) {
    const count = tree.filter((t: TreeEntry) => t.type === "blob" && t.path.startsWith(`${prefix}${d}/`)).length;
    if (count) ignored.push({ type: d, count });
  }

  const files: { path: string; content: string }[] = [];
  if (needsFiles) {
    let total = 0;
    for (const p of selectPluginFiles(tree, prefix, { maxFiles: MAX_PLUGIN_FILES })) {
      const content = await raw(p);
      if (content == null) continue;
      const bytes = Buffer.byteLength(content, "utf8");
      const rel = p.slice(prefix.length);
      if (bytes > MAX_PLUGIN_FILE_BYTES) { notes.push(`${rel}: file too large, skipped`); continue; }
      if (total + bytes > MAX_PLUGIN_TOTAL_BYTES) { notes.push(`plugin files exceed the size cap; some were skipped`); break; }
      total += bytes;
      files.push({ path: rel, content: Buffer.from(content, "utf8").toString("base64") });
    }
  }

  return { commit, version, displayName, connectors, skills, ignored, notes, files, needsFiles };
}

/** Every decision `routeServer` used to make while writing, as a value.
 *
 *  Three outcomes, kept distinct so a skipped definition can never leak into
 *  `plan.connectors`: `routeServer` returns before its push today, and
 *  `manifest.connectors` must not gain an entry it did not have. */
type PlanConnectorResult =
  | { routed: PlannedConnector; note?: string }
  | { skipped: string }
  | null;

function planConnector(name: string, originKey: string, def: ServerDef): PlanConnectorResult {
  if (!def || typeof def !== "object") return null;
  if (def.command || def.type === "stdio") {
    if (!def.command) return { skipped: `${name}: local server has no command, skipped` };
    const bundled = refsPluginRoot(serverDefParts(def));
    const envUnresolved = def.env ? Object.values(def.env).some(hasUnresolvedPlaceholder) : false;
    const note = bundled
      ? `${name}: ships code that runs in users' sandboxes — review and enable it in Extensions`
      : envUnresolved
        ? `${name}: needs configuration — open Connectors to finish`
        : `${name}: runs third-party code in your sandbox — review and enable it in Extensions`;
    return {
      routed: { name, originKey, kind: "stdio", command: def.command, args: def.args, env: def.env,
                bundled, envUnresolved, hasPlaceholder: false },
      note,
    };
  }
  if (!def.url) return { skipped: `${name}: no URL, skipped` };
  const hasPlaceholder = def.headers ? JSON.stringify(def.headers).includes("${") : false;
  return {
    routed: { name, originKey, kind: "remote", url: def.url, headers: def.headers,
              bundled: false, envUnresolved: false, hasPlaceholder },
    ...(hasPlaceholder ? { note: `${name}: needs an access key — open Connectors to add it` } : {}),
  };
}
```

- [ ] **Step 4: Rewrite `applyPlugin` to consume the plan**

In `install.ts`, replace the whole body of `applyPlugin` with a call to `buildPluginPlan` plus the writes, keeping `detectAuthKind` here for now (Task 3 moves it):

```typescript
export async function applyPlugin(gh: GitHubRef, tag: string, target: InstallTarget, only?: string[]): Promise<ApplyResult> {
  const plan = await buildPluginPlan(gh, only);
  const manifest: InstallManifest = {
    skills: [], connectors: [], ignored: plan.ignored, notes: plan.notes, commit: plan.commit,
    ...(plan.version ? { version: plan.version } : {}),
    ...(plan.displayName ? { displayName: plan.displayName } : {}),
  };

  for (const c of plan.connectors) {
    if (c.kind === "stdio") {
      const sid = await upsertStdioServer({ ...target, name: c.name, command: c.command!, args: c.args, env: c.env, source: tag });
      await setEnabled(sid, false);
    } else {
      let authKind: "token" | "oauth" = "token";
      try { authKind = await detectAuthKind(c.url!); } catch { /* default token */ }
      const secrets = c.headers && !c.hasPlaceholder ? { headers: c.headers } : undefined;
      const id = await upsertServer({ ...target, name: c.name, url: c.url!, secrets, authKind, source: tag });
      if (c.hasPlaceholder) await setEnabled(id, false);
    }
    manifest.connectors.push(c.name);
  }

  for (const s of plan.skills) {
    await ingestSkill(s.parsed, s.files, { ...target, source: tag });
    manifest.skills.push(s.name);
  }

  return { manifest, files: plan.files };
}
```

Delete the now-dead `routeServer`, the parsing blocks, and the `IGNORED_DIRS` / `MAX_*` constants from `install.ts` — they live in `plan.ts` now. Remove imports that became unused (`extractServers`, `parseManifestMcp`, `refsPluginRoot`, `serverDefParts`, `hasUnresolvedPlaceholder`, `selectPluginFiles`, `parseSkillMarkdown`, `ghTree`, `ghRaw`, `resolveCommit`, `ghFetch`); `lint` will name any you miss.

- [ ] **Step 5: Run both suites**

Run: `npx vitest run src/lib/marketplace && npx tsc --noEmit && npm run lint`
Expected: PASS, with the Task 1 characterization file **unmodified**. If a fixture fails, the split changed behaviour — fix the source, not the fixture.

Note the one intentional difference the fixtures already tolerate: notes for skipped definitions are emitted during parsing rather than during routing, but their relative order is unchanged because both loops iterate `Object.entries(servers)` in the same order.

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketplace/plan.ts src/lib/marketplace/install.ts src/lib/marketplace/__tests__/plan.test.ts
git commit -m "refactor(marketplace): extract buildPluginPlan as an artifact-only parser

Fetch and parse now produce a plain ResolvedPluginPlan with no writes and no probes,
so a plan for a fixed SHA is reproducible — asserted directly. applyPlugin keeps the
writes and, for now, the OAuth probe. The characterization suite is unchanged."
```

---

### Task 3: `observePluginPlan` — the probe, relocated

**Files:**
- Create: `src/lib/marketplace/observe.ts`
- Modify: `src/lib/marketplace/install.ts` (`applyPlugin` takes observations)
- Test: `src/lib/marketplace/__tests__/observe.test.ts` (create)

**Interfaces:**
- Consumes: `ResolvedPluginPlan` (Task 2), `detectAuthKind` (`@/lib/mcp/oauth/detect`).
- Produces:
  ```typescript
  interface ReviewObservations { detectedAuth: Record<string, "token" | "oauth"> }  // keyed by connector name
  observePluginPlan(plan: ResolvedPluginPlan): Promise<ReviewObservations>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/marketplace/__tests__/observe.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/marketplace/__tests__/observe.test.ts`
Expected: FAIL — `Failed to resolve import "../observe"`.

- [ ] **Step 3: Create `observe.ts`**

```typescript
import { detectAuthKind } from "@/lib/mcp/oauth/detect";
import type { ResolvedPluginPlan } from "./plan";

/**
 * What the world said about a plan, as opposed to what the artifact says. Recomputed
 * on every apply and never persisted into a baseline: a stale probe result stored as
 * an artifact property would make the next upgrade read a DNS change as a plugin
 * change (see docs/plugin-install-review-spec.md §4).
 *
 * Phase A carries only the OAuth probe `applyPlugin` already performed. `preflightUrl`
 * arrives in Phase B — Phase A introduces no network call that did not exist.
 */
export interface ReviewObservations {
  /** Connector name → the auth kind its endpoint advertises. Absent for stdio. */
  detectedAuth: Record<string, "token" | "oauth">;
}

export async function observePluginPlan(plan: ResolvedPluginPlan): Promise<ReviewObservations> {
  const detectedAuth: Record<string, "token" | "oauth"> = {};
  for (const c of plan.connectors) {
    if (c.kind !== "remote" || !c.url) continue;
    // A probe failure is a verdict, not an error: the install proceeds with the same
    // `token` default it uses today.
    try { detectedAuth[c.name] = await detectAuthKind(c.url); } catch { detectedAuth[c.name] = "token"; }
  }
  return { detectedAuth };
}
```

- [ ] **Step 4: Make `applyPlugin` take observations instead of probing**

In `install.ts`, change the signature and the remote branch:

```typescript
export async function applyPlugin(
  gh: GitHubRef, tag: string, target: InstallTarget, only?: string[],
): Promise<ApplyResult> {
  const plan = await buildPluginPlan(gh, only);
  const obs = await observePluginPlan(plan);
  ...
      const authKind = obs.detectedAuth[c.name] ?? "token";
      const secrets = c.headers && !c.hasPlaceholder ? { headers: c.headers } : undefined;
      const id = await upsertServer({ ...target, name: c.name, url: c.url!, secrets, authKind, source: tag });
```

Remove the `detectAuthKind` import from `install.ts`.

- [ ] **Step 5: Run every suite**

Run: `npx vitest run src/lib/marketplace && npx tsc --noEmit && npm run lint`
Expected: PASS, characterization file still unmodified — including the fixture that asserts `authKind: "oauth"` reaches the row, which now travels through `ReviewObservations`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketplace/observe.ts src/lib/marketplace/install.ts src/lib/marketplace/__tests__/observe.test.ts
git commit -m "refactor(marketplace): move the OAuth probe out of the write path

detectAuthKind ran inside the routing loop, so the same SHA could produce different
results and the writer could not be tested without a network stub. It is now
observePluginPlan, computed before apply and passed in. Same call, same fallback to
token on failure — no new probe."
```

---

### Task 4: `applyPlanResources` — the only writer

**Files:**
- Create: `src/lib/marketplace/apply.ts`
- Modify: `src/lib/marketplace/install.ts` (`applyPlugin` becomes a three-line wrapper)
- Test: `src/lib/marketplace/__tests__/apply.test.ts` (create)

**Interfaces:**
- Consumes: `ResolvedPluginPlan` (Task 2), `ReviewObservations` (Task 3), `upsertServer`, `upsertStdioServer`, `setEnabled` (`@/lib/mcp/service`), `ingestSkill` (`@/lib/skills/service`).
- Produces:
  ```typescript
  applyPlanResources(
    plan: ResolvedPluginPlan,
    obs: ReviewObservations,
    tag: string,
    target: { scope: "system" | "user"; userId: string | null; projectId: string | null },
  ): Promise<InstallManifest>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/marketplace/__tests__/apply.test.ts`:

```typescript
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
import type { ResolvedPluginPlan } from "../plan";

const TARGET = { scope: "system" as const, userId: null, projectId: null };
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
      { detectedAuth: {} }, TAG, TARGET,
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
      { detectedAuth: {} }, TAG, TARGET,
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
      { detectedAuth: { a: "oauth" } }, TAG, TARGET,
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
        { detectedAuth: {} }, TAG, TARGET,
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(h.calls).toEqual(["upsertServer"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/marketplace/__tests__/apply.test.ts`
Expected: FAIL — `Failed to resolve import "../apply"`.

- [ ] **Step 3: Create `apply.ts`**

```typescript
import { setEnabled, upsertServer, upsertStdioServer } from "@/lib/mcp/service";
import { ingestSkill } from "@/lib/skills/service";
import type { ReviewObservations } from "./observe";
import type { ResolvedPluginPlan } from "./plan";
import type { InstallManifest } from "./types";

/**
 * The only place a plan becomes rows. Performs no fetch and no probe, so it is safe
 * to call with a transaction open (docs/plugin-install-review-spec.md §7) and testable
 * without a network stub.
 */
export async function applyPlanResources(
  plan: ResolvedPluginPlan,
  obs: ReviewObservations,
  tag: string,
  target: { scope: "system" | "user"; userId: string | null; projectId: string | null },
): Promise<InstallManifest> {
  const manifest: InstallManifest = {
    skills: [], connectors: [], ignored: plan.ignored, notes: plan.notes, commit: plan.commit,
    ...(plan.version ? { version: plan.version } : {}),
    ...(plan.displayName ? { displayName: plan.displayName } : {}),
  };

  for (const c of plan.connectors) {
    if (c.kind === "stdio") {
      // Every marketplace stdio server runs third-party code in a user's sandbox, so
      // all of them install OFF and an admin enables them from Extensions.
      const sid = await upsertStdioServer({ ...target, name: c.name, command: c.command!, args: c.args, env: c.env, source: tag });
      await setEnabled(sid, false);
    } else {
      const authKind = obs.detectedAuth[c.name] ?? "token";
      const secrets = c.headers && !c.hasPlaceholder ? { headers: c.headers } : undefined;
      const id = await upsertServer({ ...target, name: c.name, url: c.url!, secrets, authKind, source: tag });
      if (c.hasPlaceholder) await setEnabled(id, false);
    }
    manifest.connectors.push(c.name);
  }

  for (const s of plan.skills) {
    await ingestSkill(s.parsed, s.files, { ...target, source: tag });
    manifest.skills.push(s.name);
  }

  return manifest;
}
```

- [ ] **Step 4: Reduce `applyPlugin` to a wrapper**

```typescript
async function applyPlugin(gh: GitHubRef, tag: string, target: InstallTarget, only?: string[]): Promise<ApplyResult> {
  const plan = await buildPluginPlan(gh, only);
  const obs = await observePluginPlan(plan);
  return { manifest: await applyPlanResources(plan, obs, tag, target), files: plan.files };
}
```

Keep the temporary `export` — Task 5 removes both it and the function. Delete the write imports from `install.ts` that `apply.ts` now owns (`upsertServer`, `upsertStdioServer`, `ingestSkill`), keeping `setEnabled`, `deleteServer` and `deleteSkill` if other functions in the file still use them; `lint` will name any that became unused.

- [ ] **Step 5: Run every suite**

Run: `npx vitest run src/lib/marketplace && npx tsc --noEmit && npm run lint`
Expected: PASS, characterization file still unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketplace/apply.ts src/lib/marketplace/install.ts src/lib/marketplace/__tests__/apply.test.ts
git commit -m "refactor(marketplace): extract applyPlanResources as the only writer

Every row a plugin install creates now comes from one function that takes a plan and
observations and touches no network — the property the consent gate needs, since a
review is only meaningful if what applies is what was reviewed."
```

---

### Task 5: Point the callers at the three functions and delete the wrapper

**Files:**
- Modify: `src/lib/marketplace/install.ts` (`installPlugin` ~line 261, `upgradePlugin` ~line 376; delete `applyPlugin` and `ApplyResult`)
- Modify: `src/lib/marketplace/__tests__/apply-characterization.test.ts` (re-point at the three functions)

**Interfaces:**
- Consumes: `buildPluginPlan`, `observePluginPlan`, `applyPlanResources`.
- Produces: no new interface. `installPlugin` and `upgradePlugin` keep their existing signatures and return `InstallManifest` exactly as before.

- [ ] **Step 1: Re-point the characterization harness**

In `apply-characterization.test.ts`, replace the import and `runFixture` body — every fixture expectation stays byte-identical:

```typescript
import { applyPlanResources } from "../apply";
import { observePluginPlan } from "../observe";
import { buildPluginPlan } from "../plan";

async function runFixture(
  files: Record<string, string>,
  only?: string[],
  authKind: "token" | "oauth" = "token",
) {
  h.state.files = files;
  h.state.tree = Object.keys(files).map((path) => ({ path, type: "blob" as const, sha: "s" }));
  h.state.authKind = authKind;
  const plan = await buildPluginPlan(GH, only);
  const obs = await observePluginPlan(plan);
  const manifest = await applyPlanResources(plan, obs, TAG, TARGET);
  return { manifest, files: plan.files };
}
```

- [ ] **Step 2: Run it — the fixtures must pass through the new path unchanged**

Run: `npx vitest run src/lib/marketplace/__tests__/apply-characterization.test.ts`
Expected: PASS. This is the moment the phase is proven: the same fourteen fixtures, the same manifests, the same writer journals, through three functions instead of one.

- [ ] **Step 3: Update `installPlugin`**

Replace `const { manifest, files } = await applyPlugin({ ...gh, ref }, `catalog:${installId}`, target, opts.only);` with:

```typescript
  const plan = await buildPluginPlan({ ...gh, ref }, opts.only);
  const obs = await observePluginPlan(plan);
  const manifest = await applyPlanResources(plan, obs, `catalog:${installId}`, target);
  const files = plan.files;
```

- [ ] **Step 4: Update `upgradePlugin`**

Replace `const { manifest, files } = await applyPlugin({ ...gh, ref: toSha }, tag, target);` with:

```typescript
  const plan = await buildPluginPlan({ ...gh, ref: toSha });
  const obs = await observePluginPlan(plan);
  const manifest = await applyPlanResources(plan, obs, tag, target);
  const files = plan.files;
```

- [ ] **Step 5: Delete `applyPlugin` and `ApplyResult`**

Remove the wrapper function and the `ApplyResult` interface from `install.ts`. `ApplyResult` has no other consumer — the plan carries `files` now.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: PASS. The whole suite, not just this directory — `installPlugin` and `upgradePlugin` are exercised by `install.test.ts` and `uninstall.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/marketplace/install.ts src/lib/marketplace/__tests__/apply-characterization.test.ts
git commit -m "refactor(marketplace): install and upgrade orchestrate build/observe/apply

The characterization fixtures now run through the three functions and produce the same
manifests and the same ordered writes as the single function they replaced, which is
what makes the split safe to build on. applyPlugin and its test-only export are gone."
```

---

### Task 6: Pin the properties the later phases depend on

Phase B assumes a plan is reproducible and that the writer is offline. Those are
properties, not behaviours, so they need their own tests rather than riding along in a
characterization fixture.

**Files:**
- Modify: `src/lib/marketplace/__tests__/plan.test.ts`

**Interfaces:**
- Consumes: `buildPluginPlan`.
- Produces: no new interface.

- [ ] **Step 1: Add the property tests**

Append to `plan.test.ts`:

```typescript
describe("properties the later phases rely on", () => {
  it("builds a plan without any write path in scope", async () => {
    // plan.ts must not import a service that writes. Enforced by inspection rather
    // than mocking: a mock proves nothing was CALLED, this proves nothing was WIRED.
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../plan.ts", import.meta.url), "utf8"));
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
```

- [ ] **Step 2: Run and confirm they pass**

Run: `npx vitest run src/lib/marketplace/__tests__/plan.test.ts`
Expected: PASS. If the import-inspection test fails, a write path was wired into the parser — that is the regression this phase exists to prevent, so fix the import rather than the test.

- [ ] **Step 3: Commit**

```bash
git add src/lib/marketplace/__tests__/plan.test.ts
git commit -m "test(marketplace): pin plan reproducibility and the parser's isolation

Phase B builds on two properties: a plan for a fixed SHA is deeply equal on a rebuild,
and the parser has no writer or probe wired into it at all. The second is asserted by
inspecting imports — a mock only proves nothing was called."
```

---

## Notes for the executor

- **Never edit a characterization fixture to make a refactor pass.** The fixtures are the definition of correct for this phase. A failure means the code moved wrong. The only exception is Task 1 Step 3, where a fixture may be wrong because it was written against unread code.
- **`originKey` is new data, not new behaviour.** Nothing in Phase A reads it; it exists because Phase B's delta needs it and computing it later would mean re-parsing. It is the one field in the plan with no counterpart in today's code.
- **Do not add `preflightUrl`, a surface type, a delta or a hash.** Those are Phase B. This phase ends with three functions and the same behaviour.
- If a step's expected output differs from what you see, stop and report it rather than adjusting the plan — a surprise here usually means the source has changed since 2026-08-14.
