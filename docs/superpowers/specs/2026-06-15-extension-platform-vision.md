# unClaw Extension Platform — North-Star Vision (the "App Store")

**Date:** 2026-06-15
**Status:** Vision / north-star. Orients the A→B→C→D build order; not itself an implementation plan.
**Companion:** `2026-06-15-skills-engine-design.md` (sub-project A, the first brick).

## 1. Philosophy: an App Store, for non-technical users

The end state is not "a list of plugins." It is a **curated store in the philosophy of the Apple App Store**: beautiful, trustworthy, opinionated, and "it just works." A non-technical company employee opens it, sees an editorial shelf of things that will obviously help them, taps **Install once**, and it works — no JSON, no transports, no secrets-in-a-config-file.

Principles, and what we steal from whom:

- **Curated, not a firehose** (Apple App Store review). Users browse a *reviewed shelf*, never raw GitHub. The 11k+ plugins and 21k+ skills in the wild are the *supply*; the *store* is a curated subset an admin (or unClaw's default curation) blessed.
- **Editorial & beautiful** (App Store "Today", Raycast Store). Collections, "picked for your team", screenshots, clear one-line value. Raycast's store is the closest existing analog to "an extensions store for non-developers" — fast, visual, one-click.
- **Capability labels** (iOS privacy "nutrition labels"). Before install, plainly: *"This can run code in your private sandbox · reach the internet · use your Notion account."* No jargon.
- **Sandbox as the guarantee** (iOS app sandbox). Everything executable runs inside the per-user Docker sandbox, never the host. That hard boundary is what lets non-technical users install community content safely.
- **One-tap install + automatic, re-scanned updates** (App Store). Install and update are buttons, not commands.
- **Verified publishers + install counts + ratings** (VS Code Marketplace) — surfaced as trust signals, honestly (see §5).

## 2. The standards reality — why "one standard" is achievable

There is **not one standard; there are two, and both converged in Dec 2025 under the Linux Foundation:**

- **MCP** (Model Context Protocol) — the de-facto substrate for **tools/servers**. Adopted by OpenAI, Google, Microsoft, AWS, Cloudflare; donated by Anthropic to the Agentic AI Foundation (LF) co-founded with OpenAI + Block. Wire schema: `server.json` (transports `stdio`/`streamable-http`/`sse`, `environmentVariables[].isSecret`, `packages[]`/`remotes[]`).
- **Agent Skills** (`SKILL.md`) — the open standard for **instructions**, governed at agentskills.io, consumed by ~30 platforms (Claude Code, Codex, Gemini, Copilot, Cursor, Goose…).

**Convergence is at the wire level; the only remaining fragmentation is the discovery/registry layer — and federation there is blessed by the MCP spec itself** (a Generic Registry API any registry implements; incremental sync via `updated_since`). OpenAI's Apps SDK *is* an MCP server under the hood — so **we get OpenAI by being good at MCP, not by building an OpenAI adapter** (their hosted GPT Store / Apps directory is closed and non-enumerable anyway).

**Therefore "наче один стандарт" = we normalize only the discovery layer into one canonical `CatalogItem`.** The protocols already agree.

## 3. Federation — source adapters into one catalog

A **Catalog Service** aggregates external registries into local, normalized `CatalogItem`s, then enriches and curates. Adapters, by priority:

1. **Generic Registry API adapter (`server.json`)** — primary. Covers the official MCP Registry (`registry.modelcontextprotocol.io`, no auth) **and every conformant subregistry** (e.g. PulseMCP, ~18k enriched). Incremental cursor + `updated_since`. Also captures OpenAI apps that publish to MCP registries.
2. **REST adapters:** Glama (no-auth, ~36k, largest crawl), Smithery (Bearer; richest trust: `verified`, `useCount`, `security.scanPassed`).
3. **Git-repo adapters (no API):** Docker `mcp-registry` (`server.yaml`, best supply-chain trust), Claude plugin marketplaces (discover via `claudemarketplaces.com` → fetch raw `marketplace.json`, **JSONC** — tolerant parser; ingestible firehoses incl. `anthropics/claude-plugins-community` ≈2200 pre-scanned plugins), Skills (glob `**/SKILL.md` over curated repos like `anthropics/skills`).
4. **Skip as programmatic sources:** mcp.so (no API), Composio/OpenTools (not listings), the entire OpenAI-hosted side (non-enumerable).

**Caveats baked into the design:** no registry offers a bulk dump (all paginate); the official registry is preview (possible resets); rate limits are undocumented — so the Catalog Service caches locally and degrades gracefully.

### Canonical `CatalogItem` (the normalization target)

- **Identity:** canonical id (reverse-DNS `name`, else `source:slug`), `displayName`, `description`, `iconUrl`, `homepage`, `repository{url,subfolder}`, `license` (SPDX).
- **Kind:** `skill` | `mcp-server` | `claude-plugin` | `openai-app` (a subtype of mcp-server). Drives rendering + install flow.
- **Provenance:** origin registry, upstream `source` attribution, `isOfficial`.
- **Install/runtime (polymorphic):** MCP → `packages[]` (npm/pypi/oci/mcpb + runtimeHint) and `remotes[]`, `transport`; plugin → the 5 Anthropic `source` forms (github/url/git-subdir/npm/relpath, sha wins over ref); skill → git repo + path to `SKILL.md`.
- **Capabilities (for the permission label):** declared tools/resources (MCP), bundled components (plugin), whether it executes code / makes network calls.
- **Secrets/config (unified):** `{ name, description, isRequired, isSecret, default }` — MCP `environmentVariables`, Glama JSON-schema, Smithery `configSchema`, Docker `secrets` all map onto this one shape.
- **Trust signals** (§5) and **lifecycle** (`version`, `isLatest`, `publishedAt`, `updatedAt`, deprecation/takedown).

## 4. "Use every plugin feature to the max" — capability matrix

A Claude Code plugin / MCP server exposes many component types. We honor the maximal surface that maps to a hosted, non-technical product — and are honest about what does not.

| Plugin / MCP feature | unClaw concept | Where |
|---|---|---|
| `skills/` (SKILL.md) | Skills (progressive-disclosure instructions) | **A** |
| `commands/` (slash commands) | User "quick actions" — one-tap prompts. Anthropic itself converged commands→skills; legacy `commands/*.md` load like skills | **A** (as user-invocable skills) |
| MCP `tools` | Agent tools merged into the loop | **B** |
| MCP `resources` | Readable context the agent can pull | **B** (after tools) |
| MCP `environmentVariables`/secrets | The store's secret-config flow at install | **C/D** |
| OpenAI Apps SDK `ui://widget/*` (MCP-UI) | Rich interactive cards rendered in chat — a flagship "Apple polish" feature | **B+ / later** |
| `agents/` (subagents) | Specialized assistants | Future (post-D) |
| `mcpServers` (.mcp.json in a plugin) | Routed into B at install | **C** |
| `hooks/`, `lspServers`, `outputStyles` | Power-user / dev-only; little value for non-technical hosted users | **N/A** (parse, ignore) |

The rule: **parse and preserve everything in `frontmatter`/manifest** (forward-compat), **activate** what maps, **explicitly ignore** what doesn't — never reject a plugin because it carries a component we don't use.

## 5. Trust & safety — the curated gate

The audience (non-technical staff, shared admin key, single org) plus community supply = supply-chain risk is the central problem. The store is the answer:

- **Risk tiers by capability**, shown as a colour + plain label: pure skill (markdown) = *safe*; skill with scripts = *runs code in your sandbox*; MCP server = *connects to an external service & uses credentials*; unverified source = *flagged*.
- **Curation gate (Apple review analog).** Admin approves what enters *their org's* store; unClaw ships a default curated shelf. Users never install from the raw firehose.
- **Provenance + verification + FRESHNESS.** Surface verified-publisher, install counts, security-scan verdicts (Smithery/Docker expose these via API). But the **postmark-mcp** rug-pull (Sep 2025: a verified publisher shipped malware in v1.0.16 after 15 clean releases) is the design lesson: *verified ≠ safe*. So **re-scan on every update** and surface a freshness signal, not just a one-time badge.
- **Permission consent at install** (iOS model): the capability label is a consent screen, not fine print.
- **Sandbox isolation** is the hard guarantee that makes all of the above acceptable.

## 6. Build order & the seams A must lay now

The order stands: **A (Skills) → B (MCP client) → C (plugin/marketplace installer) → D (store UX)**, with the **Catalog Service / federation** threading through C and D.

A must lay these seams now so later bricks need no migration:
- `skills.source` already records provenance — extend its vocabulary to `'manual' | 'catalog:<catalogItemId>'` when C lands. (Already in the A spec.)
- `skills.scope` (`system|user|project`) — "installed by admin for the org" = system scope. (Already in the A spec.)
- Adopt the **unified secret/config descriptor shape** `{name, description, isRequired, isSecret, default}` as the canonical type now (even though A's pure-markdown skills don't use secrets), so B/C reuse it verbatim.
- Keep the parser **lenient & total**: store unknown frontmatter in `frontmatter` jsonb rather than failing — the same discipline the catalog needs for unknown plugin components.

Everything else in this document is a destination, reached one reviewed brick at a time.
