# Marketplace Installer (Sub-project C1) — Design

**Date:** 2026-06-15
**Status:** Approved (user chose C; spec→implementation directly) → ready to build
**Part of:** the unClaw extension ecosystem. Turns the engine (A skills, B MCP+OAuth) into the **"App Store for non-technical users"**: add a Claude plugin marketplace, browse it, one-click install — skills route into A, remote MCP connectors route into B.

## Goal

An admin adds a **Claude plugin marketplace** (a GitHub repo with `.claude-plugin/marketplace.json`), browses its plugins, and **installs one with a click**. Install fetches the plugin's files and routes its components into the systems that already run them: `skills/`+`commands/` → A (skills, `system` scope), `.mcp.json` http/sse servers → B (connectors, `system` scope). Uninstall removes exactly what was installed. Unknown components (agents/hooks/lsp/outputStyles) are parsed, recorded, and ignored — never a reason to reject a plugin.

Non-goals for C1: stdio MCP servers (stored as a noted skip until B2); the polished editorial store UI (D — C1 ships a functional browse/install list); federation across non-Claude registries (later catalog adapters); per-user installs (C1 installs at `system` scope, admin-gated).

## Grounded in the real format (verified against the official marketplace)

- **`marketplace.json`**: `{ name, description, owner:{name,email}, plugins: [ { name, description, author:{name}, category, homepage, version?, source } ] }`.
- **`source`** (polymorphic): `git-subdir` `{source, url, path, ref?, sha?}`, `github` `{source, repo}`, `git` `{source, url, ref?, sha?}`, `npm`, `url`, or a bare relative-path string (plugin lives in the marketplace repo). **sha wins over ref.** C1 supports the GitHub-backed forms (`git-subdir`, `github`, `git` on github.com) and bare relative paths within a GitHub marketplace repo; `npm`/non-GitHub `url` are listed-but-not-installable in C1 (clear "unsupported source" note).
- **`.claude-plugin/plugin.json`**: minimal `{ name, description, author }`; components are convention dirs at plugin root.
- **`.mcp.json`**: `{ mcpServers: { <name>: { type:"http"|"sse"|"stdio", url?, headers?, command?, args?, env? } } }`. Secrets appear as `${ENV_VAR}` placeholders in `headers`/`env`. A `_meta` block (icons/tool titles) is preserved, not interpreted. (Real files vary — tolerate a missing `mcpServers` wrapper.)
- **Skills**: `skills/<name>/SKILL.md` (+ bundled files). **Commands**: `commands/*.md` — loaded as skills (Anthropic converged commands→skills).

## Fetching (no git binary, SSRF-guarded)

GitHub only in C1. Resolve `(owner, repo, ref, subdir)` from `source`, then:
1. **One git-trees call** — `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1` → the full file list. (`ref` = sha if present, else ref, else `HEAD`.)
2. **Fetch only the files we need** as raw blobs — `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` — `.claude-plugin/plugin.json`, `.mcp.json`, every `skills/**/SKILL.md` and its sibling files, `commands/*.md`, scoped to the plugin's subdir.

All requests go through **`createGuardedFetch`** (SSRF: per-request + per-redirect validation) — the marketplace URL is admin-supplied. An optional `github_token` setting is sent as `Authorization` to lift rate limits (stored encrypted, like other secrets). github.com/raw/api hosts are public, but the guard stays on for defense-in-depth and to honor `block_private_provider_urls`.

## Data model

```
plugin_marketplaces            -- a registry the admin trusts
  id         text pk
  url        text             -- github repo URL (canonicalized)
  name       text             -- from marketplace.json
  owner      text null
  catalog    jsonb            -- cached normalized CatalogItem[] (re-fetchable)
  refreshedAt timestamp
  createdAt  timestamp

plugin_installs                -- what got installed, for uninstall + status
  id          text pk
  marketplaceId text -> plugin_marketplaces.id cascade
  pluginName  text
  version     text null        -- sha/ref pinned at install
  scope       text default 'system'
  manifest    jsonb            -- { skills:[names], connectors:[names], ignored:[{type,count}], notes:[] }
  installedBy  text -> users.id
  createdAt   timestamp
  index (marketplaceId)
```

Routed rows reuse B1/A's `source` column: **`source = 'catalog:<installId>'`** on every `skills`, `skill_files`, and `mcp_servers` row created by an install. Uninstall = delete those by source + the install row (FK cascade handles oauth client/token rows on connector delete).

## Modules — `src/lib/marketplace/`

- **`types.ts`** — `PluginSource` (the polymorphic union), `CatalogItem` (normalized: id, name, description, author, category, homepage, kind, source), `InstallManifest`.
- **`source.ts`** — `resolveGitHub(source)` → `{owner, repo, ref, subdir} | null` (handles git-subdir/github/git/relative; sha>ref). Pure, unit-tested.
- **`fetch.ts`** — `ghTree(owner,repo,ref)`, `ghRaw(owner,repo,ref,path)` over `createGuardedFetch` + optional token; `parseMarketplace(json)` → `CatalogItem[]` (tolerant, total — unknown fields preserved, bad entries skipped with a note).
- **`install.ts`** — `installPlugin({ marketplaceId, pluginName, installedBy })`: resolve source → tree → read plugin.json + `.mcp.json` + skills/commands → route into A (`ingestSkill`-style insert) and B (`upsertServer`), tag `source=catalog:<id>`, build + store the manifest. `.mcp.json` `${ENV}` headers → connector saved **disabled** with a "needs configuration" note (admin fills the secret, then enables); url-only http servers → enabled. stdio servers → recorded in `manifest.notes`, skipped. `uninstallPlugin(installId)` → delete routed rows + install.
- **`service.ts`** — marketplace CRUD + `refreshCatalog`, `listMarketplaces`, `listCatalog`, `listInstalls`.

## API — admin-only (`requireAdmin`)

- `POST /api/admin/marketplaces` `{url}` → fetch+parse+store; `GET` list; `DELETE ?id=`.
- `POST /api/admin/marketplaces/refresh` `{id}` → re-pull catalog.
- `GET /api/admin/marketplaces/catalog?id=` → normalized CatalogItem[] (+ installed flag).
- `POST /api/admin/marketplaces/install` `{marketplaceId, pluginName}` → install; returns manifest summary.
- `POST /api/admin/marketplaces/uninstall` `{installId}`.

C1 is admin/system-scope only (matches B1's admin-gated `system` authoring and the shared-key audience). Per-user install lands with the governance layer.

## UI — `settings/marketplace` (admin)

A new admin settings tab. Two views:
1. **Marketplaces** — add by URL, list added ones, refresh/remove.
2. **Browse** — cards per `CatalogItem`: favicon/category, name, author, one-line description, a **capability label** ("runs skills" / "connects to an external service & uses credentials" — the iOS-style nutrition label from the vision doc), and **Install / Installed / Uninstall**. After installing a connector with `${ENV}` secrets, a friendly nudge: "Added — open Connectors to add its access key and turn it on." All strings uk-formal.

## Security

- **SSRF:** every fetch through `createGuardedFetch`; marketplace URL validated on add.
- **Supply-chain (the central risk for this audience):** install is **admin-only**; the version is **pinned** (sha when the source provides one) so an install is reproducible and a later upstream change doesn't silently alter it (the postmark-mcp lesson — re-scan/refresh is explicit, not automatic). Capability labels make "this runs code / uses credentials" a consent screen.
- **Secrets:** never invent credentials — `${ENV}` placeholders become a disabled "needs configuration" connector; the admin supplies the real secret via B's encrypted flow. Optional `github_token` stored encrypted.
- **Scope:** installs are `system`; only `requireAdmin` can add/install/uninstall.

## Testing (vitest)

- **Unit (pure):** `resolveGitHub` for git-subdir/github/git/relative incl. sha>ref precedence and non-GitHub→null; `parseMarketplace` normalizes the real official-marketplace shape and skips malformed entries; manifest routing — given a fake plugin tree (mocked tree+raw), `installPlugin` produces the expected skills[]/connectors[] and tags `source=catalog:<id>`; `${ENV}` connector saved disabled.
- **Guarded fetch** reuse is already covered in `net/ssrf`.
- **e2e (manual):** add the official marketplace, install a skills plugin (superpowers) and a remote-MCP plugin (Notion), verify they appear under Skills/Connectors and the agent can use them; uninstall removes them.

## Forward-compat

- `CatalogItem.kind` + `source` are the normalization target the federation layer (other registries) will reuse.
- `plugin_installs.scope` opens to `user`/`project` installs with the governance layer.
- `manifest.ignored` records agents/hooks/etc. so a later brick can activate them without re-fetching.
