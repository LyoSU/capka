# MCP Client + Connectors (Sub-project B1) — Design

**Date:** 2026-06-15
**Status:** Approved design → ready for implementation plan
**Part of:** the unClaw extension ecosystem. Build order: A (Skills, done) → **B (MCP)** → C (installer) → D (marketplace). B is split into **B1 — remote MCP (this spec)** and **B2 — stdio-in-sandbox bridge (deferred outline at end)**.

## Goal

Let the agent use external services ("connectors" — Notion, Linear, GitHub, Google, …) through the Model Context Protocol. B1 connects to **remote MCP servers** (Streamable HTTP / SSE) and merges their tools into the agent loop alongside the sandbox tools and the `skill` tool. No process execution — the safest slice for non-technical users on a shared admin key.

Non-goals for B1: stdio servers (B2), OAuth flows (static tokens first), MCP `resources`/`prompts` and MCP-UI widgets (later), catalog install (C/D).

## Why these libraries

AI SDK `6.0.116` has **no built-in MCP client** (the v5 `experimental_createMCPClient` was removed). So B uses the official **`@modelcontextprotocol/sdk`** Client directly, and adapts each MCP tool into an AI SDK **`dynamicTool`** (exported by `ai`; designed for runtime-defined schemas). This keeps the client transport single and explicit.

## Scoping & credential model (the core decision)

A connector is bound to exactly one **scope**, and that scope *is* the binding — there is no separate ownership concept. The server's credential lives on the same row, so the credential's reach equals the server's scope:

| Scope | Who sees/uses it | Credential |
|---|---|---|
| `system` | Every user in the deployment (the organization) | One **shared org credential** (e.g. a company Notion integration token) — all users act as the same account |
| `user` | One user, across all their chats/projects | That **user's own credential** |
| `project` | One project | The project's credential |

This directly satisfies "bind to the user, or globally to the organization": a `system` server is the org-wide connector; a `user` server is personal. Precedence on name collision mirrors skills: **project > user > system** (most specific wins), resolved in the service layer.

**Deliberately deferred — per-user credentials on an org-defined server.** The pattern "admin offers one Notion connector, but each employee signs in with their own Notion account" needs a separate `(userId, serverId) → credential` binding. It lands naturally with **OAuth** (B-later), because OAuth tokens are per-user by nature. B1 keeps credentials on the server row; a user who needs their own account creates a `user`-scope server. The schema leaves room for the binding table without migration of existing rows.

## Architecture

### Data model — new `mcp_servers` table

Mirrors the `skills` scoping pattern.

```
mcp_servers
  id          text pk
  scope       text  -- 'system' | 'user' | 'project'
  userId      text  null  -- null for system; FK users, cascade
  projectId   text  null  -- set only for project scope; FK projects, cascade
  name        text        -- namespace, ^[a-z0-9]+(-[a-z0-9]+)*$ , 1..64
  transport   text        -- 'http' | 'sse' | 'stdio'  (stdio rejected until B2)
  url         text  null   -- remote endpoint (http/sse)
  command     text  null   -- stdio (B2)
  args        jsonb        -- stdio args (B2), default []
  secrets     text  null   -- AES-GCM ciphertext (crypto.ts) of a JSON
                           --   { headers?: Record<string,string>, env?: Record<string,string> }
  enabled     boolean default true
  source      text  default 'manual'  -- 'manual' | later 'catalog:<id>'
  createdAt   timestamp
  updatedAt   timestamp

  index on (userId), (projectId), (scope)
```

Uniqueness of (scope, owner, name) is enforced in the service layer (nullable owner columns make a SQL unique index treat NULLs as distinct), as with skills.

### Modules — `src/lib/mcp/`

- **`types.ts`** — `McpScope`, `McpTransport`, `McpServerConfig` (decrypted, runtime), `McpServerInfo`. Reuses the `SecretDescriptor` seam from `src/lib/skills/types.ts` where a connector declares required secrets (forward-compat for the catalog).
- **`client.ts`** — `connectMcpServer(cfg, signal)`: build `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` (or SSE) to `cfg.url`, inject `cfg.secrets.headers` (e.g. `Authorization: Bearer …`), `connect()`, return `{ client, tools: await client.listTools() }`. Bounded connect timeout.
- **`adapt.ts`** — `adaptMcpTool(client, serverName, mcpTool)`: returns an AI SDK `dynamicTool` whose `inputSchema` is `jsonSchema(mcpTool.inputSchema)` and whose `execute` calls `client.callTool({ name, arguments })`, returning the tool result content. **Tool name is namespaced `mcp__<server>__<tool>`** — collision-free against sandbox/skill tools, deterministic, matches the ecosystem convention.
- **`service.ts`** — `listEnabledServers(userId, projectId)` (scope merge + precedence dedupe + enabled filter, like skills), `ingestServer`/CRUD, secret encrypt/decrypt via `@/lib/crypto`. SSRF-guards `url` on write (see Security).
- **`load.ts`** — `loadMcpTools({ userId, projectId, signal })`: connect all enabled servers with **bounded concurrency**, adapt their tools, return `{ tools: Record<string, Tool>, close: () => Promise<void> }`. **A server that fails to connect is logged and skipped — it never aborts the run.** Tools collected in deterministic order (servers by name, tools by name) for cache stability.

### Integration — `runner.ts → prepareRun`

```ts
const sandbox = await loadSandboxTools(...);
const mcp = await loadMcpTools({ userId, projectId, signal: ac.signal });
const skillTool = makeSkillTool({ ... });
const tools = { ...sandbox.tools, ...mcp.tools, skill: skillTool };
// closeMcp now disposes BOTH sandbox and mcp clients
```

Cache: the tool set is stable per run (namespaced, sorted) so the position-0 tools prefix stays cacheable across turns; enabling/disabling a server is a rare, deliberate invalidation.

### Config UX

A `settings/connections` (admin) + per-user surface to add a connector: `name`, `transport: http`, `url`, and secret headers/token. Secrets are write-only (never returned). Scope is chosen (system = org-wide, requires admin; user = personal). Reuses the existing settings patterns and `crypto.ts`. Listing shows connection health (a lightweight `listTools` probe) and an enable/disable toggle.

## Error handling

- Connect failure / timeout / 401 → server skipped for the run; a role-aware friendly error (via `@/lib/errors/friendly`) is logged; the agent proceeds with the remaining tools.
- Tool-call errors flow through the runner's existing `tool-error` handling.
- A misconfigured server never blocks chat — degrade gracefully.

## Security

- **SSRF:** `url` is untrusted input. On write (and before connect) run it through the existing private-URL guard honoring the `block_private_provider_urls` setting — the same protection already applied to provider base URLs. Reject private/loopback/link-local hosts unless an admin has opted in.
- **Secrets at rest:** encrypted with AES-GCM via `@/lib/crypto` (master key), exactly like provider keys / telegram token. Never returned by any read endpoint.
- **Secrets in transit:** injected as request headers by the platform's MCP client; they never enter the sandbox.
- **Scope enforcement:** a user may only create/edit `user`-scope servers they own; `system`/`project` are admin/owner-gated in the API.

## Testing (vitest)

- **Unit:** `adapt` — MCP tool JSON schema → `dynamicTool` with correct `inputSchema` and namespaced name; `service` — scope merge + precedence dedupe + enabled filter; secret encrypt→decrypt round-trip; SSRF guard rejects private URLs.
- **Integration:** an in-memory MCP server (`@modelcontextprotocol/sdk` in-memory transport) — `connectMcpServer` → `listTools` → adapted tool `execute` round-trips a call; a failing server is skipped by `loadMcpTools` without throwing.

## Forward-compat seams

- `secrets` shape is the encrypted form of the unified `{ headers, env }`; `env` is unused in B1 but ready for stdio (B2).
- `source` grows to `'catalog:<id>'` when C installs connectors from the marketplace.
- `transport: 'stdio'` + `command`/`args` columns exist now but are rejected by the service until B2.
- The per-user-credential-on-org-server binding table is additive (no migration of B1 rows) and arrives with OAuth.

## Administration & permissions (future governance layer)

The user requirement: connectors (and skills) must be **administrable** — an org admin governs what users may do, not just what exists. This is a cross-cutting layer over A (skills), B (MCP), and C/D (catalog). B1 ships the first brick of it; the rest is designed-for, not built yet.

**What B1 already enforces:**
- **Scope-gated authoring** — only admins create `system`/`project` connectors; users create only their own `user`-scope ones. Same gate applies to skills.
- **Secrets are write-only and encrypted** — no user can read another's (or the org's) credential.

**Designed-for (later increments, additive — no migration of B1 rows):**
- **Per-tool permission policy** — `allow | ask | deny` per connector (and per tool within it), evaluated at call time, mirroring Anthropic/OpenCode's model. A `deny` hides the tool from the agent; `ask` routes to a human-in-the-loop confirmation. Stored as a policy column/table keyed by scope + server (+ optional tool glob).
- **Org allowlist / blocklist** — admins curate which catalog connectors and skills users may install or enable at all (ties into the curated marketplace D and the `code-audit`/risk-tier model from the vision doc).
- **Role matrix** — extends the existing `role: 'admin' | 'user' | 'viewer'`: e.g. `viewer` cannot enable connectors; a future `manager` role may govern a project's connectors. Reuses `requireRole`.
- **Audit trail** — who added/enabled/used which connector, for compliance (non-technical org context).

These map onto the same `scope` + service-layer gating B1 introduces, so adding them is new policy data + checks, not a re-architecture.

## B2 — stdio-in-sandbox (deferred outline)

The sandbox image ships an MCP **stdio→HTTP gateway** (e.g. supergateway). The `sandbox-controller` gains an endpoint to launch `gateway --stdio "<command> <args>"` in the session container and expose an internal port; the platform connects via a controller-proxied Streamable HTTP route — so the platform's client transport stays HTTP for every server. The stdio server's own egress is governed by the project's `sandboxNetwork` mode. This is its own spec → plan → implementation cycle after B1 ships.
