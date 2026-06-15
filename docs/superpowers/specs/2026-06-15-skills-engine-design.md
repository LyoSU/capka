# Skills Engine (Sub-project A) — Design

**Date:** 2026-06-15
**Status:** Approved design → ready for implementation plan
**Part of:** the unClaw extension ecosystem ("OpenCode, but for non-technical users"). Build order: **A (Skills) → B (MCP client) → C (plugin/marketplace installer) → D (marketplace UX)**. This spec covers **A only**.

## Goal

Give unClaw Anthropic-compatible **Agent Skills**: packaged, reusable instructions (markdown + optional bundled scripts) that the agent loads on demand. Format and loading mechanism mirror Anthropic Claude Code and OpenCode **exactly**, so skills authored for those ecosystems run here unchanged — this is what makes the future marketplace (D) viable: the content already exists.

Non-goals for A: remote marketplace install, MCP, slash-command `/skill` menu, dynamic `!`command`` preprocessing, `context: fork` subagents, skill hooks, `paths` auto-activation. (Listed under *Deliberate v1 cuts*.)

## Audience constraint

Real users are non-technical company staff on a shared admin key (single org per deployment). Therefore: **users consume, admins/marketplace provision.** Users see a list of available skills and an enable/disable toggle — nothing more. Authoring/uploading is admin-only.

## How skills work (copied verbatim from OpenCode / Anthropic)

Two-phase **progressive disclosure**:

- **Phase 1 — discovery (always in context, cheap).** Only `name + description` of each available skill is injected into the system prompt, rendered as:
  ```
  ## Available Skills
  - **<name>**: <description>
  ```
  Source: `fmt()` ported from OpenCode `packages/opencode/src/skill/index.ts`. No skill bodies are injected.

- **Phase 2 — on demand.** A native AI SDK tool `skill({ name })` returns the **full SKILL.md body** wrapped in `<skill_content name="…">`, plus the skill's base directory in the sandbox and a sampled list of its bundled files. Bodies never enter context until the model calls the tool. Source: OpenCode `packages/opencode/src/tool/skill.ts`.

`Info` shape (from OpenCode): `{ name, description?, location, content }`. Only `name` and `description` are load-bearing frontmatter fields; everything else is stored for forward-compat but not interpreted in v1.

## Architecture

### Data model — new `skills` table

Mirrors the `memories` scoping pattern, with an explicit scope column instead of nullable-field inference.

```
skills
  id          text pk
  scope       text  -- 'system' | 'user' | 'project'
  userId      text  null   -- null for system scope; FK users, cascade
  projectId   text  null   -- set only for project scope; FK projects, cascade
  name        text         -- ^[a-z0-9]+(-[a-z0-9]+)*$ , 1..64
  description text  null    -- 1..1024; skills without a description are hidden from fmt()
  body        text         -- markdown body, denormalized cache of SKILL.md
  frontmatter jsonb        -- full parsed frontmatter (forward-compat)
  source      text         -- 'manual' (admin upload) | later 'plugin:<id>'
  enabled     boolean default true
  createdAt   timestamp
  updatedAt   timestamp

  unique (scope, coalesce(userId,''), coalesce(projectId,''), name)
  index on (userId), (projectId), (scope)
```

**Source of truth.** The **bundle files** (SKILL.md + `scripts/` + resources, exactly as uploaded) live in the existing file storage (`data/storage`) under the skill id. The DB `description`/`body`/`frontmatter` are a **denormalized cache** parsed at ingest — regenerated on every re-ingest, so they cannot drift. DB powers the hot path (prompt injection, UI list) without a storage read; storage powers materialization.

### Scope precedence

`listAvailable(userId, projectId)` merges the three tiers visible to the caller — system (all users) + that user's user-scope skills + (if in a project) that project's skills — filters to `enabled`, then **dedupes by name with precedence project > user > system** (most specific wins, matching OpenCode's first-wins-by-discovery-order intent). Only `enabled` rows are injected.

`enabled` lives on the row (admin toggles a system skill for everyone; a user toggles their own). Per-user override of a system skill is a join table — deferred (YAGNI).

### Service — `src/lib/skills/`

- **`parse.ts`** — `gray-matter` with a sanitize-retry fallback (OpenCode's fix for issue #8331: unquoted colons in `description` crash strict YAML). Validates `name` regex + dir-name match + length limits. Returns `{ name, description?, body, frontmatter }` or a typed error.
- **`service.ts`** — `listAvailable(userId, projectId)` (scope filter + enabled + dedupe), `get(userId, projectId, name)`, `ingest(...)` (parse → upsert DB row by name-within-scope + write bundle to storage).
- **`fmt.ts`** — renders the `## Available Skills` block. Port of OpenCode `fmt()`. Guard: skip rows with no description; truncate each description to ~500 chars; if a caller exceeds N skills, log (soft budget guard, Anthropic caps ~1% context).
- **`materialize.ts`** — `materializeSkill(sessionKey, name)`: writes one skill's bundle from storage into the sandbox at `/skills/<name>/`, **just-in-time** (see below). Sanitizes every entry path (reject `..`, absolute paths, symlinks → zip-slip protection); `name` is regex-validated so the directory segment is safe.
- **`tool.ts`** — `makeSkillTool({ userId, sessionKey, projectId })`: an AI SDK `tool()` taking `{ name }`. On call: resolve via `service.get`; if missing, return an error listing available names (model self-corrects, as OpenCode does); **materialize the skill into the sandbox now**; `ls`/`find` its dir for the file manifest; return `<skill_content name>…body…</skill_content>` + `Base directory for this skill: /skills/<name>` + `<skill_files>` list.

### Lazy / JIT materialization (critical)

Materialization happens **inside the `skill` tool**, not at session start. Most runs use zero skills, so upfront materialization would write every skill's files into Docker on every task for nothing. JIT keeps phase 1 DB-only (no sandbox round-trip) and only touches the sandbox for skills the model actually invokes — cheaper and a faithful match to progressive disclosure.

### Integration points (3 existing files, minimal edits)

1. **`runner.ts → prepareRun`**: call `listAvailable(userId, projectId)` → pass to `buildSystemPrompt`; compose the skill tool into the record: `const tools = { ...sandbox.tools, skill: makeSkillTool({ userId, sessionKey, projectId: payload.projectId }) }`. **Cleanup:** rename the misleading `const mcp = await loadSandboxTools(...)` → `const sandbox = ...` (it is not MCP; real MCP arrives in sub-project B).
2. **`prompt.ts → buildSystemPrompt`**: new optional `skills` param → append the `fmt()` block after memories.
3. **`sandbox/tools.ts`**: untouched. The skill tool is composed in `prepareRun`, keeping sandbox tools a pure self-contained set.

### Ingestion (v1, admin-only)

- **Admin upload**: POST a `.zip` containing `SKILL.md` (+ optional `scripts/`, resources). Server parses, validates, sanitizes paths, writes bundle to storage, upserts the DB row (by name within the chosen scope). Scope chosen by admin (system/user/project).
- **Dev seed**: a script that imports the repo's on-disk `.claude/skills/*` into the table for local testing/dogfooding.
- **User-facing**: a read-only "Skills" list (name, description, scope badge) with an enable/disable toggle. No authoring.

## Deliberate v1 cuts (YAGNI + security)

- **`!`command`` dynamic preprocessing & `$ARGUMENTS` substitution** — cut. OpenCode's tool also returns the raw body; the agent runs scripts explicitly via `execute_bash`. Avoids executing arbitrary bash during prompt assembly.
- **`allowed-tools` / `disallowed-tools`** — parsed and stored in `frontmatter`, but **no-op**. The agent already runs autonomously inside the sandbox with no per-tool permission prompts, so there is nothing to gate yet.
- **`/skill-name` user slash menu, `context: fork`, skill-scoped `hooks`, `paths` auto-activation, `model`/`effort` overrides** — not built; fields preserved in `frontmatter` for later.
- **Remote install (plugin/marketplace)** — sub-projects C/D.

## Security

- Skill bodies are **untrusted instructions** (a prompt-injection surface, like any skill or marketplace content). They only ever influence the model; they grant no new capability by themselves.
- Bundled scripts execute **only inside the per-user Docker sandbox**, never on the platform host. Materialization writes to `/skills`, isolated from the user's `/workspace` data.
- **Zip-slip protection**: every bundle entry path is sanitized at materialization (reject `..`, absolute paths, symlinks). `name` regex prevents traversal in the `/skills/<name>/` segment.
- Upload endpoint is admin-only and size-bounded.

## Testing (vitest, already in project)

- **Unit:** parser — valid skill, missing `name`, name/dir mismatch, **colon-in-description** (issue #8331 regression), oversized fields; `fmt()` rendering + description-less skip; `listAvailable` scope merge + precedence dedupe + enabled filter; path sanitizer rejects `../` and absolute paths.
- **Integration:** `ingest` writes storage + DB row; `skill` tool materializes into a sandbox session, returns body + correct base dir + file manifest; pure-markdown skill (no scripts) returns empty file list cleanly.

## Dev note

Adding skills to the runner means the in-process worker must be reloaded: **restart the platform container** after editing runner/skills/sandbox code (HMR does not reload the worker loop).

## Forward-compat seams (for the catalog — see `2026-06-15-extension-platform-vision.md`)

A lays these now so B/C/D need no migration:
- `skills.source` vocabulary grows to `'manual' | 'catalog:<catalogItemId>'` when the Catalog Service lands — the column exists now.
- `skills.scope = 'system'` already models "admin installed for the whole org" — the store's default install target.
- Define the **unified secret/config descriptor** type `{ name, description, isRequired, isSecret, default }` (the normalization of MCP `environmentVariables` / Glama / Smithery / Docker) as a shared type now, even though pure-markdown skills don't use it — B/C reuse it verbatim.
- Parser stays **lenient & total**: unknown frontmatter is preserved in `frontmatter` jsonb, never a hard failure — the same discipline the catalog needs for unknown plugin components.

## Out of scope (future sub-projects)

- **B** — MCP client: connect external MCP servers, merge their tools into the loop; security model for stdio-in-sandbox vs remote-only.
- **C** — plugin manifest + installer: parse `.claude-plugin/plugin.json` + `marketplace.json`, install from git, route bundled skills into A and MCP servers into B.
- **D** — marketplace UX: non-technical one-click browse/install/update, trust & permissions surfacing.
