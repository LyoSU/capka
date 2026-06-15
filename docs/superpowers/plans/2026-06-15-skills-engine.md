# Skills Engine (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give unClaw Anthropic-compatible Agent Skills — packaged markdown instructions (+ optional bundled scripts) that the agent loads on demand via two-phase progressive disclosure, exactly as Claude Code / OpenCode do.

**Architecture:** Pure parser/formatter functions (no I/O) → DB tables (`skills` + `skill_files`) → a service layer (list/get/ingest with scope precedence) → a `skill({name})` AI SDK tool that lazily materializes a skill's files into the per-user Docker sandbox and returns its body → wired into the agent loop (`runner.ts`) and system prompt (`prompt.ts`). Skill bundles live in Postgres (base64), not a new file store. See spec `docs/superpowers/specs/2026-06-15-skills-engine-design.md` and vision `…-extension-platform-vision.md`.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM + Postgres, AI SDK 6 (`tool()`), `gray-matter` (frontmatter), `adm-zip` (admin upload), Vitest.

---

## File Structure

**New — `src/lib/skills/`**
- `types.ts` — `SkillScope`, `SecretDescriptor` (forward-compat seam), `ParsedSkill`, `SkillInfo`, `SkillParseError`.
- `parse.ts` — `parseSkillMarkdown(raw)`: gray-matter + sanitize fallback + validation.
- `paths.ts` — `sanitizeBundlePath(p)`: zip-slip protection.
- `fmt.ts` — `formatAvailableSkills(list)`: the `## Available Skills` block.
- `service.ts` — `listAvailableSkills`, `getSkillForRun`, `ingestSkill`.
- `materialize.ts` — `materializeSkill(sessionKey, name, body, files)`.
- `tool.ts` — `makeSkillTool(ctx)`: the `skill({name})` AI SDK tool.
- `seed.ts` — `ingestSkillFromDir(dir, target)` dev/test importer.
- `__tests__/` — `parse.test.ts`, `paths.test.ts`, `fmt.test.ts`, `service.test.ts`.

**New — API & UI**
- `src/app/api/skills/route.ts` — GET (user list) + PATCH (toggle enabled).
- `src/app/api/admin/skills/route.ts` — POST (admin zip upload).
- `src/app/(dashboard)/settings/skills/page.tsx` + `src/components/settings/skills-list.tsx` — minimal read-only list with enable/disable.

**Modify**
- `package.json` — add deps + `test` script.
- `src/lib/db/schema.ts` — add `skills`, `skill_files` tables (+ `jsonb`, `boolean` imports).
- `src/lib/chat/prompt.ts` — `buildSystemPrompt` gains a `skills` param.
- `src/lib/tasks/runner.ts` — load skills, inject, compose `skill` tool, rename `mcp`→`sandbox`.

**Convention:** run a single test file with `npx vitest run <path>`; whole suite with `npx vitest run`.

---

## Task 0: Dependencies & test script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime + dev deps**

Run:
```bash
npm install gray-matter adm-zip
npm install -D @types/adm-zip
```
Expected: `gray-matter` and `adm-zip` appear in `dependencies`, `@types/adm-zip` in `devDependencies`.

- [ ] **Step 2: Add a `test` script**

In `package.json` `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Verify the toolchain runs**

Run: `npx vitest run`
Expected: existing suite (e.g. `presenter.test.ts`, `pricing.test.ts`) passes.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(skills): add gray-matter + adm-zip deps and test script"
```

---

## Task 1: Shared types

**Files:**
- Create: `src/lib/skills/types.ts`

- [ ] **Step 1: Write the types**

```ts
/** Scope tiers, most-specific last. Precedence on name collision: project > user > system. */
export type SkillScope = "system" | "user" | "project";

/**
 * Unified secret/config descriptor — the normalization target for MCP
 * `environmentVariables`, Glama JSON-schema, Smithery `configSchema`, Docker
 * `secrets`. Defined now as a forward-compat seam (sub-projects B/C reuse it);
 * pure-markdown skills do not populate it yet.
 */
export interface SecretDescriptor {
  name: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  default?: string;
}

/** Result of parsing a SKILL.md file. */
export interface ParsedSkill {
  name: string;
  description?: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

/** A skill row as served to the run / UI. */
export interface SkillInfo {
  id: string;
  scope: SkillScope;
  name: string;
  description: string | null;
  body: string;
  enabled: boolean;
}

export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors from `types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/skills/types.ts
git commit -m "feat(skills): shared types + forward-compat secret descriptor"
```

---

## Task 2: Bundle path sanitizer (zip-slip protection)

**Files:**
- Create: `src/lib/skills/paths.ts`
- Test: `src/lib/skills/__tests__/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { sanitizeBundlePath } from "../paths";

describe("sanitizeBundlePath", () => {
  it("accepts a normal relative path", () => {
    expect(sanitizeBundlePath("scripts/run.py")).toBe("scripts/run.py");
  });
  it("strips a leading ./", () => {
    expect(sanitizeBundlePath("./reference.md")).toBe("reference.md");
  });
  it("rejects traversal", () => {
    expect(sanitizeBundlePath("../etc/passwd")).toBeNull();
    expect(sanitizeBundlePath("scripts/../../x")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(sanitizeBundlePath("/etc/passwd")).toBeNull();
  });
  it("rejects empty / dot-only", () => {
    expect(sanitizeBundlePath("")).toBeNull();
    expect(sanitizeBundlePath(".")).toBeNull();
  });
  it("normalizes backslashes", () => {
    expect(sanitizeBundlePath("scripts\\win.ps1")).toBe("scripts/win.ps1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/skills/__tests__/paths.test.ts`
Expected: FAIL — `sanitizeBundlePath` not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Normalize and validate a path from an untrusted skill bundle.
 * Returns the safe relative path, or null if it must be rejected
 * (absolute, traversal, empty). Protects against zip-slip.
 */
export function sanitizeBundlePath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!norm || norm === ".") return null;
  if (norm.startsWith("/")) return null;
  const segs = norm.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs.join("/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/skills/__tests__/paths.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/paths.ts src/lib/skills/__tests__/paths.test.ts
git commit -m "feat(skills): zip-slip-safe bundle path sanitizer"
```

---

## Task 3: SKILL.md parser

**Files:**
- Create: `src/lib/skills/parse.ts`
- Test: `src/lib/skills/__tests__/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "../parse";
import { SkillParseError } from "../types";

const md = (fm: string, body = "Do the thing.") => `---\n${fm}\n---\n${body}`;

describe("parseSkillMarkdown", () => {
  it("parses a valid skill", () => {
    const r = parseSkillMarkdown(md(`name: my-skill\ndescription: Does a thing`));
    expect(r.name).toBe("my-skill");
    expect(r.description).toBe("Does a thing");
    expect(r.body).toBe("Do the thing.");
    expect(r.frontmatter.name).toBe("my-skill");
  });

  it("preserves unknown frontmatter (lenient & total)", () => {
    const r = parseSkillMarkdown(md(`name: x\ndescription: y\nversion: 2.0.0\nallowed-tools: Bash(git *)`));
    expect(r.frontmatter.version).toBe("2.0.0");
    expect(r.frontmatter["allowed-tools"]).toBe("Bash(git *)");
  });

  it("recovers from an unquoted colon in description (issue #8331)", () => {
    const r = parseSkillMarkdown(md(`name: x\ndescription: Use when: the user asks`));
    expect(r.name).toBe("x");
    expect(r.description).toContain("Use when");
  });

  it("rejects a missing or invalid name", () => {
    expect(() => parseSkillMarkdown(md(`description: no name`))).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(md(`name: Has Spaces\ndescription: y`))).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(md(`name: UPPER\ndescription: y`))).toThrow(SkillParseError);
  });

  it("treats description as optional", () => {
    const r = parseSkillMarkdown(md(`name: bare`));
    expect(r.description).toBeUndefined();
  });

  it("rejects an over-long description", () => {
    const long = "a".repeat(1025);
    expect(() => parseSkillMarkdown(md(`name: x\ndescription: ${long}`))).toThrow(SkillParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/skills/__tests__/parse.test.ts`
Expected: FAIL — `parseSkillMarkdown` not found.

- [ ] **Step 3: Implement**

```ts
import matter from "gray-matter";
import { ParsedSkill, SkillParseError } from "./types";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;

/**
 * gray-matter's YAML parser is strict: an unquoted colon in a scalar value
 * (common in skill descriptions like "Use when: …") throws. OpenCode hit the
 * same bug (#8331) and wraps parsing with a sanitize-retry. We quote bare
 * scalar values that contain a colon, then re-parse.
 */
function sanitizeFrontmatter(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return raw;
  const fixed = m[1]
    .split("\n")
    .map((line) => {
      const kv = line.match(/^(\s*[A-Za-z0-9_-]+:)\s+(.*)$/);
      if (!kv) return line;
      const [, key, value] = kv;
      const v = value.trim();
      if (!v || /^["'[{|>]/.test(v) || !v.includes(":")) return line;
      return `${key} "${v.replace(/"/g, '\\"')}"`;
    })
    .join("\n");
  return raw.replace(m[1], fixed);
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    parsed = matter(sanitizeFrontmatter(raw));
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const name = data.name;
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > MAX_NAME) {
    throw new SkillParseError(
      `Invalid skill name "${String(name)}" — must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be ≤${MAX_NAME} chars`,
    );
  }

  let description: string | undefined;
  if (typeof data.description === "string") {
    if (data.description.length > MAX_DESC) {
      throw new SkillParseError(`Skill "${name}" description exceeds ${MAX_DESC} chars`);
    }
    description = data.description;
  }

  return { name, description, body: parsed.content.trim(), frontmatter: data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/skills/__tests__/parse.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/parse.ts src/lib/skills/__tests__/parse.test.ts
git commit -m "feat(skills): SKILL.md parser with colon-recovery + validation"
```

---

## Task 4: Available-skills formatter

**Files:**
- Create: `src/lib/skills/fmt.ts`
- Test: `src/lib/skills/__tests__/fmt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { formatAvailableSkills } from "../fmt";

describe("formatAvailableSkills", () => {
  it("renders a sorted markdown list", () => {
    const out = formatAvailableSkills([
      { name: "zebra", description: "Z" },
      { name: "alpha", description: "A" },
    ]);
    expect(out).toContain("## Available Skills");
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("zebra"));
    expect(out).toContain("- **alpha**: A");
  });

  it("skips skills without a description", () => {
    const out = formatAvailableSkills([
      { name: "shown", description: "yes" },
      { name: "hidden", description: null },
    ]);
    expect(out).toContain("shown");
    expect(out).not.toContain("hidden");
  });

  it("returns empty string when nothing is describable", () => {
    expect(formatAvailableSkills([{ name: "x", description: null }])).toBe("");
    expect(formatAvailableSkills([])).toBe("");
  });

  it("truncates very long descriptions", () => {
    const out = formatAvailableSkills([{ name: "x", description: "d".repeat(900) }]);
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("…");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/skills/__tests__/fmt.test.ts`
Expected: FAIL — `formatAvailableSkills` not found.

- [ ] **Step 3: Implement**

```ts
const MAX_DESC_IN_PROMPT = 500;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Phase-1 progressive disclosure: render only name + description of each
 * describable skill (ported from OpenCode `fmt()`). Returns "" when there is
 * nothing to show so the caller can skip the section entirely.
 */
export function formatAvailableSkills(list: { name: string; description: string | null }[]): string {
  const described = list.filter((s) => s.description && s.description.trim());
  if (described.length === 0) return "";
  const lines = described
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- **${s.name}**: ${truncate(s.description!.trim(), MAX_DESC_IN_PROMPT)}`);
  return [
    "## Available Skills",
    "When a skill below fits the request, call the `skill` tool with its name to load full instructions.",
    ...lines,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/skills/__tests__/fmt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/fmt.ts src/lib/skills/__tests__/fmt.test.ts
git commit -m "feat(skills): available-skills prompt formatter"
```

---

## Task 5: Database schema + migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: migration under `drizzle/` (generated)

- [ ] **Step 1: Ensure column-type imports exist**

At the top of `src/lib/db/schema.ts`, confirm the `drizzle-orm/pg-core` import includes `jsonb` and `boolean`. If missing, add them to the existing import list (alongside `pgTable`, `text`, `timestamp`, `index`).

- [ ] **Step 2: Append the two tables**

After the `memories` table in `src/lib/db/schema.ts`:

```ts
export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // 'system' | 'user' | 'project'
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  body: text("body").notNull(),
  frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().default({}),
  source: text("source").notNull().default("manual"), // 'manual' | later 'catalog:<id>'
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_skills_user_id").on(table.userId),
  index("idx_skills_project_id").on(table.projectId),
  index("idx_skills_scope").on(table.scope),
]);

// Bundled files (scripts/, references) — base64 content. SKILL.md body lives in
// skills.body; this table holds everything else, materialized into the sandbox
// on demand. Postgres is the source of truth (no separate file store).
export const skillFiles = pgTable("skill_files", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  content: text("content").notNull(), // base64
}, (table) => [index("idx_skill_files_skill_id").on(table.skillId)]);
```

> Note: uniqueness of (scope, owner, name) is enforced in `ingestSkill` (Task 7), not by a DB constraint — nullable `userId`/`projectId` make a SQL unique index treat NULLs as distinct, which would not prevent duplicate system-scope rows.

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file in `drizzle/` creating `skills` and `skill_files`. Open it and confirm both `CREATE TABLE` statements and the indexes are present.

- [ ] **Step 4: Apply it**

Run: `npx drizzle-kit migrate`
Expected: applies cleanly against the dev Postgres. (If the DB is not running, start it via `npm run docker:dev` first.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts drizzle/
git commit -m "feat(skills): skills + skill_files tables and migration"
```

---

## Task 6: Service — list & get with scope precedence

**Files:**
- Create: `src/lib/skills/service.ts`
- Test: `src/lib/skills/__tests__/service.test.ts`

This task covers the pure precedence/dedup logic in isolation so it is unit-testable without a DB. The DB queries are thin wrappers around it.

- [ ] **Step 1: Write the failing test (dedup logic)**

```ts
import { describe, it, expect } from "vitest";
import { dedupeByPrecedence } from "../service";
import type { SkillInfo } from "../types";

const s = (over: Partial<SkillInfo>): SkillInfo => ({
  id: over.name ?? "id",
  scope: "system",
  name: "x",
  description: null,
  body: "",
  enabled: true,
  ...over,
});

describe("dedupeByPrecedence", () => {
  it("project beats user beats system on name collision", () => {
    const out = dedupeByPrecedence([
      s({ id: "sys", scope: "system", name: "dup" }),
      s({ id: "usr", scope: "user", name: "dup" }),
      s({ id: "prj", scope: "project", name: "dup" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("prj");
  });

  it("keeps distinct names from all tiers", () => {
    const out = dedupeByPrecedence([
      s({ id: "a", scope: "system", name: "a" }),
      s({ id: "b", scope: "user", name: "b" }),
    ]);
    expect(out.map((x) => x.name).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/skills/__tests__/service.test.ts`
Expected: FAIL — `dedupeByPrecedence` not found.

- [ ] **Step 3: Implement service**

```ts
import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { skills, skillFiles } from "@/lib/db/schema";
import type { SkillInfo, SkillScope, ParsedSkill } from "./types";

const SCOPE_RANK: Record<SkillScope, number> = { system: 0, user: 1, project: 2 };

function toInfo(row: typeof skills.$inferSelect): SkillInfo {
  return {
    id: row.id,
    scope: row.scope as SkillScope,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
  };
}

/** Most-specific scope wins on duplicate name (project > user > system). */
export function dedupeByPrecedence(list: SkillInfo[]): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const item of list) {
    const cur = byName.get(item.name);
    if (!cur || SCOPE_RANK[item.scope] > SCOPE_RANK[cur.scope]) byName.set(item.name, item);
  }
  return [...byName.values()];
}

/** Enabled skills visible to this run: system + this user + (if set) this project. */
export async function listAvailableSkills(userId: string, projectId?: string | null): Promise<SkillInfo[]> {
  const scopeFilter = projectId
    ? or(
        eq(skills.scope, "system"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId), isNull(skills.projectId)),
        and(eq(skills.scope, "project"), eq(skills.projectId, projectId)),
      )
    : or(
        eq(skills.scope, "system"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId), isNull(skills.projectId)),
      );

  const rows = await db.select().from(skills).where(and(eq(skills.enabled, true), scopeFilter));
  return dedupeByPrecedence(rows.map(toInfo));
}

/** The winning skill by name for this run, with its bundle files. */
export async function getSkillForRun(
  userId: string,
  projectId: string | null | undefined,
  name: string,
): Promise<{ info: SkillInfo; files: { path: string; content: string }[] } | null> {
  const candidates = (await listAvailableSkills(userId, projectId)).filter((x) => x.name === name);
  if (candidates.length === 0) return null;
  const info = candidates[0];
  const files = await db
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, info.id));
  return { info, files };
}

export interface IngestTarget {
  scope: SkillScope;
  userId: string | null;
  projectId: string | null;
  source?: string;
}

/** Upsert a parsed skill (+ bundle files) by (scope, owner, name). */
export async function ingestSkill(
  parsed: ParsedSkill,
  files: { path: string; content: string }[],
  target: IngestTarget,
): Promise<string> {
  const existing = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.scope, target.scope),
        target.userId ? eq(skills.userId, target.userId) : isNull(skills.userId),
        target.projectId ? eq(skills.projectId, target.projectId) : isNull(skills.projectId),
        eq(skills.name, parsed.name),
      ),
    )
    .limit(1);

  const id = existing[0]?.id ?? nanoid();
  const values = {
    id,
    scope: target.scope,
    userId: target.userId,
    projectId: target.projectId,
    name: parsed.name,
    description: parsed.description ?? null,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    source: target.source ?? "manual",
    updatedAt: new Date(),
  };

  if (existing[0]) {
    await db.update(skills).set(values).where(eq(skills.id, id));
    await db.delete(skillFiles).where(eq(skillFiles.skillId, id));
  } else {
    await db.insert(skills).values(values);
  }

  if (files.length) {
    await db.insert(skillFiles).values(files.map((f) => ({ id: nanoid(), skillId: id, path: f.path, content: f.content })));
  }
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/skills/__tests__/service.test.ts`
Expected: PASS (2 tests). (The DB functions are not exercised here — they are covered by the integration check in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/service.ts src/lib/skills/__tests__/service.test.ts
git commit -m "feat(skills): service — list/get/ingest with scope precedence"
```

---

## Task 7: Materialization into the sandbox

**Files:**
- Create: `src/lib/skills/materialize.ts`

No new unit test — exercised by Task 11's integration check (requires a live sandbox controller). Logic mirrors the proven base64 write pattern in `src/lib/sandbox/tools.ts`.

- [ ] **Step 1: Implement**

```ts
import { execCommand } from "@/lib/sandbox/client";
import { sanitizeBundlePath } from "./paths";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Write one skill's SKILL.md body + bundle files into the sandbox at
 * /skills/<name>/, just-in-time (called from the skill tool). Files are
 * base64-decoded in-container, matching the write pattern in sandbox/tools.ts.
 * Returns the absolute base dir and the list of materialized relative paths.
 */
export async function materializeSkill(
  sessionKey: string,
  name: string,
  body: string,
  files: { path: string; content: string }[],
): Promise<{ baseDir: string; files: string[] }> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`Unsafe skill name: ${name}`);
  const baseDir = `/skills/${name}`;
  const written: string[] = [];

  const writeFile = async (relPath: string, base64: string) => {
    const abs = `${baseDir}/${relPath}`.replace(/'/g, "'\\''");
    const cmd = `mkdir -p "$(dirname '${abs}')" && echo '${base64}' | base64 -d > '${abs}'`;
    await execCommand(sessionKey, cmd, 15000);
  };

  await writeFile("SKILL.md", Buffer.from(body, "utf8").toString("base64"));

  for (const f of files) {
    const safe = sanitizeBundlePath(f.path);
    if (!safe || safe === "SKILL.md") continue;
    await writeFile(safe, f.content);
    written.push(safe);
  }

  return { baseDir, files: written };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/skills/materialize.ts
git commit -m "feat(skills): JIT materialization of skill bundles into sandbox"
```

---

## Task 8: The `skill` tool

**Files:**
- Create: `src/lib/skills/tool.ts`

- [ ] **Step 1: Implement**

```ts
import { tool } from "ai";
import { z } from "zod";
import { getSkillForRun } from "./service";
import { materializeSkill } from "./materialize";
import { listAvailableSkills } from "./service";

export interface SkillToolCtx {
  userId: string;
  sessionKey: string;
  projectId: string | null;
}

/**
 * Phase-2 progressive disclosure: loads a skill's full body on demand,
 * materializing its bundle into the sandbox first. Mirrors OpenCode's
 * `skill({name})` tool — returns body + base dir + file manifest.
 */
export function makeSkillTool(ctx: SkillToolCtx) {
  return tool({
    description:
      "Load the full instructions for one of the Available Skills listed in the system prompt. " +
      "Call this when a skill's description matches the user's request, then follow its instructions. " +
      "Its bundled files (scripts, references) become available in the sandbox under the returned base directory.",
    inputSchema: z.object({
      name: z.string().describe("The exact skill name from the Available Skills list"),
    }),
    execute: async ({ name }) => {
      const loaded = await getSkillForRun(ctx.userId, ctx.projectId, name);
      if (!loaded) {
        const available = (await listAvailableSkills(ctx.userId, ctx.projectId)).map((s) => s.name);
        return { error: `Skill "${name}" not found. Available skills: ${available.join(", ") || "none"}` };
      }

      const { info, files } = loaded;
      let baseDir = `/skills/${info.name}`;
      let fileList: string[] = [];
      try {
        const mat = await materializeSkill(ctx.sessionKey, info.name, info.body, files);
        baseDir = mat.baseDir;
        fileList = mat.files;
      } catch (e) {
        // Body still useful even if file materialization failed.
        console.warn(`[skills] materialize failed for ${info.name}:`, e);
      }

      return {
        content: [
          `<skill_content name="${info.name}">`,
          info.body.trim(),
          "",
          `Base directory for this skill: ${baseDir}`,
          "Relative paths in this skill (e.g. scripts/) are relative to this base directory.",
          fileList.length ? `<skill_files>\n${fileList.map((f) => `- ${baseDir}/${f}`).join("\n")}\n</skill_files>` : "",
          `</skill_content>`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/skills/tool.ts
git commit -m "feat(skills): skill({name}) tool with lazy materialization"
```

---

## Task 9: Inject skills into the system prompt

**Files:**
- Modify: `src/lib/chat/prompt.ts`

- [ ] **Step 1: Add the param and the block**

In `buildSystemPrompt`'s `opts` type, add:
```ts
  skills?: { name: string; description: string | null }[];
```
Add the import at the top:
```ts
import { formatAvailableSkills } from "@/lib/skills/fmt";
```
After the memories block (right before the workspace snapshot block), insert:
```ts
  const skillsBlock = formatAvailableSkills(opts.skills ?? []);
  if (skillsBlock) {
    systemPrompt += `\n\n${skillsBlock}`;
  }
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/chat/prompt.ts
git commit -m "feat(skills): inject Available Skills block into system prompt"
```

---

## Task 10: Wire into the agent loop

**Files:**
- Modify: `src/lib/tasks/runner.ts:125-158` (`prepareRun`)

- [ ] **Step 1: Add imports**

At the top of `src/lib/tasks/runner.ts`:
```ts
import { listAvailableSkills } from "@/lib/skills/service";
import { makeSkillTool } from "@/lib/skills/tool";
```

- [ ] **Step 2: Load skills and compose the tool in `prepareRun`**

In `prepareRun`, change the sandbox-tools line and add skills loading. Replace:
```ts
  const mcp = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);
```
with:
```ts
  const sandbox = await loadSandboxTools(userId, sessionKey, project?.sandboxNetwork ?? undefined);
  const availableSkills = await listAvailableSkills(userId, payload.projectId ?? null);
  const skillTool = makeSkillTool({ userId, sessionKey, projectId: payload.projectId ?? null });
  const tools = { ...sandbox.tools, skill: skillTool };
```

- [ ] **Step 3: Pass skills into the prompt**

In the `buildSystemPrompt({ ... })` call inside `prepareRun`, add:
```ts
    skills: availableSkills.map((s) => ({ name: s.name, description: s.description })),
```

- [ ] **Step 4: Update the return value**

Change the `prepareRun` return from `tools: mcp.tools, closeMcp: mcp.close` to:
```ts
  return { model, provider, modelId, tools, closeMcp: sandbox.close, systemPrompt, userMemories };
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. (`hasTools` in `runAgentTask` already counts `Object.keys(tools).length`, so the new `skill` tool is included automatically.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tasks/runner.ts
git commit -m "feat(skills): load + inject skills and skill tool into the run; rename mcp->sandbox"
```

---

## Task 11: Ingestion core + dev seed

**Files:**
- Create: `src/lib/skills/seed.ts`
- Create: `scripts/seed-skills.mts`

- [ ] **Step 1: Implement the directory ingester**

`src/lib/skills/seed.ts`:
```ts
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseSkillMarkdown } from "./parse";
import { sanitizeBundlePath } from "./paths";
import { ingestSkill, type IngestTarget } from "./service";

/** Read a skill directory (SKILL.md + sibling files) and ingest it. */
export async function ingestSkillFromDir(dir: string, target: IngestTarget): Promise<string> {
  const raw = await readFile(path.join(dir, "SKILL.md"), "utf8");
  const parsed = parseSkillMarkdown(raw);

  const files: { path: string; content: string }[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(relPath); continue; }
      if (relPath === "SKILL.md") continue;
      const safe = sanitizeBundlePath(relPath);
      if (!safe) continue;
      const buf = await readFile(path.join(dir, relPath));
      files.push({ path: safe, content: buf.toString("base64") });
    }
  }
  await walk("");
  void stat; // (reserved; keep import set stable)

  return ingestSkill(parsed, files, target);
}
```

- [ ] **Step 2: Implement the seed script**

`scripts/seed-skills.mts`:
```ts
/**
 * Dev seed: import the repo's on-disk .claude/skills/* as SYSTEM skills.
 * Usage: npx tsx scripts/seed-skills.mts
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ingestSkillFromDir } from "../src/lib/skills/seed";

const root = path.resolve(".claude/skills");
const dirs = await readdir(root, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory()) continue;
  const id = await ingestSkillFromDir(path.join(root, d.name), {
    scope: "system",
    userId: null,
    projectId: null,
    source: "manual",
  });
  console.log(`seeded ${d.name} -> ${id}`);
}
process.exit(0);
```

- [ ] **Step 3: Run the seed against dev DB + sandbox**

Run: `npx tsx scripts/seed-skills.mts`
Expected: prints `seeded impeccable -> <id>`. (Requires the dev Postgres running.)

- [ ] **Step 4: Integration check — list + tool round-trip**

Manually verify in a `node`/`tsx` REPL or a throwaway script:
```ts
import { listAvailableSkills, getSkillForRun } from "../src/lib/skills/service";
console.log((await listAvailableSkills("any-user", null)).map((s) => s.name)); // includes "impeccable"
const loaded = await getSkillForRun("any-user", null, "impeccable");
console.log(loaded?.info.name, loaded?.files.length); // "impeccable" <n>
```
Expected: the system skill is visible to any user (system scope) and its files load.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/seed.ts scripts/seed-skills.mts
git commit -m "feat(skills): directory ingester + dev seed from .claude/skills"
```

---

## Task 12: Admin upload route (zip)

**Files:**
- Create: `src/app/api/admin/skills/route.ts`

- [ ] **Step 1: Implement**

```ts
import AdmZip from "adm-zip";
import { requireAdmin, apiHandler } from "@/lib/auth";
import { parseSkillMarkdown } from "@/lib/skills/parse";
import { sanitizeBundlePath } from "@/lib/skills/paths";
import { ingestSkill } from "@/lib/skills/service";
import { SkillParseError, type SkillScope } from "@/lib/skills/types";

const MAX_ZIP_BYTES = 5 * 1024 * 1024;

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();
  const form = await req.formData();
  const file = form.get("file");
  const scope = (form.get("scope") as string) || "system";
  if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
  if (file.size > MAX_ZIP_BYTES) return Response.json({ error: "Zip too large" }, { status: 413 });
  if (!["system", "user", "project"].includes(scope)) return Response.json({ error: "Bad scope" }, { status: 400 });

  const zip = new AdmZip(Buffer.from(await file.arrayBuffer()));
  const entries = zip.getEntries();

  // Find SKILL.md (allow it nested one level: <skill>/SKILL.md).
  const skillEntry = entries.find((e) => !e.isDirectory && /(^|\/)SKILL\.md$/.test(e.entryName));
  if (!skillEntry) return Response.json({ error: "No SKILL.md in zip" }, { status: 400 });
  const basePrefix = skillEntry.entryName.replace(/SKILL\.md$/, "");

  let parsed;
  try {
    parsed = parseSkillMarkdown(skillEntry.getData().toString("utf8"));
  } catch (e) {
    if (e instanceof SkillParseError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }

  const files: { path: string; content: string }[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!e.entryName.startsWith(basePrefix)) continue;
    const rel = e.entryName.slice(basePrefix.length);
    const safe = sanitizeBundlePath(rel);
    if (!safe || safe === "SKILL.md") continue;
    files.push({ path: safe, content: e.getData().toString("base64") });
  }

  const id = await ingestSkill(parsed, files, {
    scope: scope as SkillScope,
    userId: null,
    projectId: null,
    source: "manual",
  });
  return Response.json({ ok: true, id, name: parsed.name, files: files.length });
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors.

- [ ] **Step 3: Manual smoke test**

Zip the repo's `impeccable` skill and POST it as an admin (browser devtools or curl with a session cookie):
```bash
cd .claude/skills && zip -r /tmp/impeccable.zip impeccable && cd -
# then upload /tmp/impeccable.zip via the admin UI or an authenticated fetch
```
Expected: JSON `{ ok: true, name: "impeccable", files: <n> }`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/skills/route.ts
git commit -m "feat(skills): admin zip-upload ingestion route"
```

---

## Task 13: User-facing list + enable/disable

**Files:**
- Create: `src/app/api/skills/route.ts`
- Create: `src/app/(dashboard)/settings/skills/page.tsx`
- Create: `src/components/settings/skills-list.tsx`

- [ ] **Step 1: Implement the user API (list + toggle)**

`src/app/api/skills/route.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { apiHandler, getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { skills } from "@/lib/db/schema";
import { listAvailableSkills } from "@/lib/skills/service";

export const GET = apiHandler(async () => {
  const { userId } = await getAuthContext();
  const list = await listAvailableSkills(userId, null);
  return Response.json({
    skills: list.map((s) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope, enabled: s.enabled })),
  });
});

export const PATCH = apiHandler(async (req: Request) => {
  const { userId } = await getAuthContext();
  const { id, enabled } = await req.json();
  if (typeof id !== "string" || typeof enabled !== "boolean") {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  // A user may only toggle their own user-scope skills.
  const res = await db
    .update(skills)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(skills.id, id), eq(skills.userId, userId), eq(skills.scope, "user")))
    .returning({ id: skills.id });
  if (res.length === 0) return Response.json({ error: "Not found or not yours" }, { status: 404 });
  return Response.json({ ok: true });
});
```

> Confirm `getAuthContext` is exported from `@/lib/auth` (it is used to read `userId`/`role`). If the helper has a different name in `auth.ts`, use that name.

- [ ] **Step 2: Implement the list component**

`src/components/settings/skills-list.tsx` — a client component that fetches `/api/skills`, renders name + description + a scope badge, and a toggle (the toggle calls `PATCH /api/skills`; disable the control for non-`user` scope rows since those are admin-managed). Follow the existing styling patterns in `src/components/settings/`.

```tsx
"use client";
import { useEffect, useState } from "react";

type Skill = { id: string; name: string; description: string | null; scope: string; enabled: boolean };

export function SkillsList() {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    fetch("/api/skills").then((r) => r.json()).then((d) => setSkills(d.skills ?? []));
  }, []);

  async function toggle(id: string, enabled: boolean) {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    await fetch("/api/skills", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
  }

  return (
    <ul className="space-y-3">
      {skills.map((s) => (
        <li key={s.id} className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <div className="font-medium">{s.name} <span className="text-xs text-muted-foreground">· {s.scope}</span></div>
            {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
          </div>
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={s.scope !== "user"}
            onChange={(e) => toggle(s.id, e.target.checked)}
            aria-label={`Toggle ${s.name}`}
          />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Implement the page**

`src/app/(dashboard)/settings/skills/page.tsx`:
```tsx
import { SkillsList } from "@/components/settings/skills-list";

export default function SkillsSettingsPage() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-2xl font-semibold">Skills</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Reusable instructions your assistant can load on demand.
      </p>
      <SkillsList />
    </div>
  );
}
```

> Localize user-facing strings via `next-intl` to match the project convention (see other `settings` pages and `messages/`); the literals above are placeholders for the translated keys.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/skills/route.ts src/app/\(dashboard\)/settings/skills/page.tsx src/components/settings/skills-list.tsx
git commit -m "feat(skills): user skills list + enable/disable toggle"
```

---

## Task 14: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Restart the platform container**

Per the dev gotcha (HMR does not reload the in-process worker), restart so `runner.ts` changes take effect:
```bash
npm run docker:down && npm run docker:dev
```

- [ ] **Step 2: Confirm the seed skill is visible**

Open `/settings/skills` as a normal user. Expected: the seeded `impeccable` system skill appears (toggle disabled — admin-managed).

- [ ] **Step 3: Drive the agent through a skill**

In a chat, send a request that matches the seeded skill's description. Expected: the assistant calls the `skill` tool (visible as a tool-call in the run), then proceeds using the loaded instructions. Confirm in logs that `/skills/<name>/SKILL.md` was materialized.

- [ ] **Step 4: Full suite green**

Run: `npx vitest run`
Expected: all skills unit tests + the pre-existing suite pass.

- [ ] **Step 5: Commit any doc/fix touch-ups**

```bash
git add -A
git commit -m "test(skills): end-to-end verification notes" --allow-empty
```

---

## Self-Review (completed during planning)

- **Spec coverage:** data model (T5), parser+gray-matter/#8331 (T3), fmt/progressive disclosure phase 1 (T4), skill tool/phase 2 (T8), lazy JIT materialization (T7), scope precedence + system tier (T6), runner+prompt integration + `mcp`→`sandbox` rename (T9/T10), admin zip ingest + dev seed (T11/T12), user list+toggle (T13), zip-slip + name validation security (T2/T7), forward-compat seams `source`/`scope`/`SecretDescriptor`/lenient parser (T1/T3/T5/T6), tests (T2/T3/T4/T6), dev-restart gotcha (T14). All spec sections map to a task.
- **Cuts honored:** no `!`command`` preprocessing, `allowed-tools` stored-not-enforced (kept in `frontmatter`), no `/skill` menu / `context: fork` / hooks / `paths`. No catalog install (C/D).
- **Type consistency:** `ParsedSkill`/`SkillInfo`/`SecretDescriptor`/`IngestTarget` defined in T1/T6 and used unchanged in T3/T6/T7/T8/T11/T12. `ingestSkill(parsed, files, target)`, `getSkillForRun(userId, projectId, name)`, `materializeSkill(sessionKey, name, body, files)`, `formatAvailableSkills(list)` signatures consistent across all call sites.
- **Open follow-up (not blocking A):** the `SecretDescriptor` type is defined but unused until B/C — intentional seam.
