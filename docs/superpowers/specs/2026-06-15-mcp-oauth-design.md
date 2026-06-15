# MCP Connector OAuth (Sub-project B-OAuth) — Design

**Date:** 2026-06-15
**Status:** Approved (user chose spec→implementation directly) → ready to build
**Part of:** the unClaw extension ecosystem. Follows B1 (remote MCP, static-token connectors). Adds the missing auth class so connectors that require a **user sign-in** (Notion, Linear, GitHub remote, Google…) work — mirroring Claude's "Add custom connector" dialog.

## Goal

Let a non-technical user connect a remote MCP server that uses **OAuth 2.1** by clicking **"Sign in"** and authenticating with their own account in the browser — no tokens pasted by hand. Tokens are **per-user**, stored encrypted, auto-refreshed, and attached to the agent's MCP calls. Static-token connectors (B1) keep working unchanged.

Non-goals: client-credentials / service-account flows (interactive auth-code only); MCP resources/prompts; catalog install (C/D).

## Why this shape

The official `@modelcontextprotocol/sdk` already implements the whole OAuth machine. The one call `auth(provider, { serverUrl, authorizationCode? })` runs **discovery → Dynamic Client Registration → PKCE → token exchange/refresh** and returns `"REDIRECT"` (interaction needed) or `"AUTHORIZED"`. We implement an `OAuthClientProvider` whose storage hooks read/write our DB. So we write **storage + two routes + UI**, not an OAuth client from scratch.

The standalone transport accepts `{ authProvider }`; once tokens exist, the SDK attaches the bearer and refreshes automatically. No tokens → `connect` throws `UnauthorizedError` → the connector is gracefully skipped for that user (B1's skip path) and the UI shows "Sign in needed".

## Auth model (the core decision)

**Per-user tokens, even on a shared (`system`) server.** A `system` connector means *the admin defined one Notion endpoint for the org*; each employee signs in with **their own** Notion account. This is exactly the deferred `(userId, serverId) → credential` binding from the B1 spec, and it's what the user asked for ("прив'язка до юзера"). The DCR **client** registration, by contrast, is per *server* (registered once with that server's authorization server, shared by all users).

`system`/`project` servers are still admin-authored (B1 rule); OAuth only changes *whose credential is used at run time* (each caller's own).

## Data model

`mcp_servers` (B1) gains one column:
- `authKind text not null default 'token'` — `'token' | 'oauth'`. Set by **auto-detection at add time** (run OAuth protected-resource discovery against the URL; if it advertises OAuth → `oauth`, else `token`). Admin-provided OAuth Client ID/Secret also force `oauth`.

Three new tables:

```
mcp_oauth_clients              -- DCR / pre-registered client, per SERVER (shared)
  serverId   text pk  -> mcp_servers.id  cascade
  clientInfo text                         -- AES-GCM JSON: OAuthClientInformationFull {client_id, client_secret?, ...}
  createdAt  timestamp

mcp_oauth_tokens               -- the per-USER credential
  id         text pk
  userId     text   -> users.id     cascade
  serverId   text   -> mcp_servers.id cascade
  tokens     text                         -- AES-GCM JSON: OAuthTokens {access_token, refresh_token?, expires_in, ...}
  account    text  null                    -- optional display label ("you@notion")
  createdAt  timestamp
  updatedAt  timestamp
  unique (userId, serverId)               -- enforced in service layer (nullable-free)

mcp_oauth_states               -- short-lived in-flight authorization (one redirect round-trip)
  state        text pk                    -- random, unguessable
  userId       text   -> users.id  cascade
  serverId     text   -> mcp_servers.id cascade
  codeVerifier text                       -- AES-GCM PKCE verifier
  createdAt    timestamp                  -- rejected if older than OAUTH_STATE_TTL (10 min); deleted on use
```

All three secret columns use the existing `crypto.ts` master key.

## Modules — `src/lib/mcp/oauth/`

- **`provider.ts`** — `makeAuthFlowProvider(ctx)` and `makeRuntimeProvider(ctx)`, both `OAuthClientProvider`:
  - `redirectUrl` = `${APP_URL}/api/mcp/oauth/callback` (APP_URL from `BETTER_AUTH_URL`, as in `auth.ts`).
  - `clientMetadata` = `{ client_name: "unClaw", redirect_uris: [redirectUrl], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method }` (method `none` for public+PKCE, `client_secret_post` when a secret is stored).
  - `clientInformation()/saveClientInformation()` ↔ `mcp_oauth_clients` (admin-supplied id/secret seeded here on add).
  - `tokens()/saveTokens()` ↔ `mcp_oauth_tokens` for `(userId, serverId)`.
  - `state()` → random; `saveCodeVerifier()/codeVerifier()` ↔ in-memory during the flow, persisted to `mcp_oauth_states` in `redirectToAuthorization`.
  - **Flow provider** `redirectToAuthorization(url)`: persist `{state,userId,serverId,codeVerifier}`, capture `url` (the route reads it and 302s).
  - **Runtime provider** `redirectToAuthorization()`: **throws** — run time never redirects; a missing/expired token just fails connect → graceful skip.
- **`detect.ts`** — `detectAuthKind(url)`: `discoverOAuthProtectedResourceMetadata` (try/catch) → `'oauth' | 'token'`.
- **`store.ts`** — encrypted CRUD for the three tables + `getUserToken(userId, serverId)`, `deleteUserToken`, state insert/consume with TTL.

## Flow

1. **Add** (`POST /api/mcp` / admin): after upsert, `detectAuthKind(url)` sets `authKind`. If admin passed Client ID/Secret, store in `mcp_oauth_clients` and force `oauth`.
2. **Sign in** — UI button → `GET /api/mcp/oauth/start?serverId=…`:
   - `requireSession`; verify the user may use this server (own `user` row, or any `system`; `project` → membership).
   - `const r = await auth(flowProvider, { serverUrl })` → `redirectToAuthorization` fired → **302** to the captured authorization URL.
3. **Callback** — `GET /api/mcp/oauth/callback?code=…&state=…`:
   - `requireSession`; consume `state` (TTL + delete); assert `state.userId === session.userId`.
   - `await auth(flowProvider, { serverUrl, authorizationCode: code })` → SDK exchanges code, calls `saveTokens` → stored per user.
   - 302 back to `/settings/connectors?connected=<name>`.
4. **Run time** — `loadMcpTools`: for an `oauth` server, build `makeRuntimeProvider({userId,serverId})` and pass `{ authProvider }` to `connectMcpServer`. Token present → SDK attaches/refreshes; absent/expired-unrefreshable → `connect` throws → server skipped (never fatal).

## Integration points (changes to B1)

- `McpServerConfig` gains `id` and `authKind`; `listEnabledServerConfigs` returns them. For `oauth` rows it returns no static headers.
- `connectMcpServer(cfg, { …, authProvider? })` forwards `authProvider` to the transport (kept alongside the SSRF custom-fetch).
- `loadMcpTools` chooses header-secrets (token) vs runtime authProvider (oauth) per server.
- `probeUserServers`: an `oauth` server with no user token → new status **`needs_login`**; with a token → probe via authProvider.

## Config UX (mirror Claude, friendly)

The add form gains a collapsible **"Додатково"** with **OAuth Client ID** and **OAuth Client Secret** (both optional — DCR covers the common case; these are for servers requiring a pre-registered client), exactly like Claude's dialog. For an `oauth` connector the list row shows a **"Увійти"** button and status: `needs_login` → «Потрібен вхід», after sign-in → «✓ Підключено» (+ account label if available), with a **"Вийти"** (revoke local token) action. All strings uk-formal, no jargon.

## Security

- **Tokens & client secrets at rest:** AES-GCM (`crypto.ts`), write-only; never returned by any read endpoint.
- **PKCE** always (SDK default); **state** random + single-use + TTL; callback asserts session-user == state-user (prevents code-injection / cross-user binding).
- **redirect_uri** fixed to our callback; **SSRF**: discovery + token requests go through the same `assertSafeUrl`/blockPrivate policy as B1 (custom fetch reused).
- **Per-user isolation:** a user can only ever read/refresh/delete their own `(userId, serverId)` token row; admins never see user tokens.
- Run-time provider cannot trigger a redirect — no surprise interactive prompts mid-agent-run.

## Testing (vitest)

- **Unit:** `detectAuthKind` maps discovery-present→oauth, discovery-absent→token (mocked fetch); state insert→consume round-trip with TTL expiry; token/client encrypt→decrypt round-trip; runtime provider `redirectToAuthorization` throws.
- **Provider:** `flowProvider.state()` persists, `redirectToAuthorization` writes the state row, `tokens()/saveTokens()` round-trip a `(userId,serverId)` token.
- Live OAuth handshake is verified manually (Task: e2e) against a real provider — needs a browser.

## Forward-compat

- The `(userId, serverId)` token table is the binding B1 left room for — no migration of B1 rows.
- `authKind` can later grow `'oauth-cc'` (client-credentials) without schema change.
- Account label + scopes can be enriched for the catalog (C/D) trust labels.
