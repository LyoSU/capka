# stdio MCP runtime bridge + sandbox egress policy

**Status:** design (platform storage/admin/routing already shipped; runtime + egress pending, prod-verified)
**Date:** 2026-06-21
**Related:** [[2026-06-15-mcp-client-design]], [[2026-06-15-marketplace-installer-design]], `sandbox-controller/sandbox-spec.js`

## Problem

Plugins (and admins) define **stdio** MCP servers — `command` + `args` + `env`,
e.g. `npx -y duckduckgo-mcp-server` or `npx -y @playwright/mcp`. These are local
processes, not URLs. Running them in the platform process is RCE on the host, so
they must run inside the per-session gVisor sandbox. Two things are needed:

1. A **runtime bridge** so the platform's MCP client can talk to a stdio server
   running inside the sandbox container.
2. **Egress** from the sandbox, because these servers self-install on first run
   (npx fetches the package) and reach the internet (DuckDuckGo, a site Playwright
   drives). Today egress is fully cut.

## What already shipped (platform layer, commit 995f772)

- `mcp_servers` stores stdio rows (`transport=stdio`, `command`, `args`, `env` in
  encrypted `secrets`). `upsertStdioServer` (no URL/SSRF; trust boundary = sandbox).
- `listEnabledServerConfigs` serves stdio configs to the loader.
- `marketplace/install.ts` routes `.mcp.json` + inline `plugin.json` stdio servers
  into rows (bare-command only; `${CLAUDE_PLUGIN_ROOT}` bundled-binary servers
  skipped; `${...}` env placeholders → disabled + note). plugin.json version/displayName parsed.
- Admin-only "Local" connector form (command + env) + Local badge + admin
  toggle/delete of shared connectors.

## Constraint that fixes the architecture

`sandbox-spec.js`: a sandbox runs with `NetworkMode: "none"` (default) or
`"bridge"` (only when `SANDBOX_ALLOW_NETWORK=true`). **It is never attached to the
controller's compose network.** Therefore the controller cannot reach a port
inside the sandbox by IP — a stdio→HTTP gateway listening on a container port is
NOT reachable. The bridge must ride the Docker control plane (`docker exec`), which
works regardless of the container's network (it's how `exec`/files already work).

## Design: docker-exec stdio bridge

The MCP server process runs inside the sandbox via a long-lived `docker exec`
(stdio attached). The **controller** owns that exec stream and exposes the server
to the platform over the controller's existing authenticated HTTP. The process
stays isolated in gVisor; only JSON-RPC frames cross the boundary.

### Controller (sandbox-controller, plain http + dockerode)

New endpoints (Bearer-authed like the rest):

- `POST /sessions/:id/mcp/:name/start` `{ command, args, env }`
  - `container.exec({ Cmd: [command, ...args], Env, AttachStdin, AttachStdout, User, WorkingDir })`, `start({ hijack:true, stdin:true })`.
  - Keep the duplex stream in an in-process map keyed `${sessionId}:${name}`. Demux Docker frames; parse newline-delimited JSON-RPC from stdout.
  - Idempotent: reuse a live stream; respawn if dead.
- `POST /sessions/:id/mcp/:name/rpc` `{ message }` → write `JSON.stringify(message)+"\n"` to exec stdin. For request messages, resolve the matching response by `id` (timeout-bounded). Return the JSON-RPC response.
- `GET /sessions/:id/mcp/:name/events` (SSE) → stream server→client messages (notifications, sampling) that aren't request replies. Optional for v1 (tools/list + tools/call are request/response; progress notifications can be dropped initially).
- Stream lifecycle: killed on session destroy (already tears down the container) and on idle TTL.

No new controller deps; framing reuses the existing `createFrameDemux`.

### Platform (`src/lib/mcp`)

A custom `Transport` (`SandboxStdioTransport`) implementing the MCP SDK
`Transport` interface:
- `send(msg)` → `POST {CONTROLLER}/sessions/:id/mcp/:name/rpc` (controller Bearer + `workspaceToken`), SSRF guard bypassed (the controller is trusted infra, not a user URL — do NOT route through `createGuardedFetch`/`assertSafeUrl`).
- `start()` → `POST …/start` with the decrypted command/args/env, then open the SSE `…/events` for `onmessage`.
- `close()` → best-effort stop.

`connectMcpServer` branches on `cfg.transport`: `http`→`StreamableHTTPClientTransport`
(today), `stdio`→`SandboxStdioTransport(sessionKey, cfg)`. `loadMcpTools` must
therefore receive the run's `sessionKey` (the runner already has it; thread it
through). stdio servers are only attempted when the session has a sandbox.

### Image

No change required for the common case: Node 22 + `npx` and Python + `uv` are
already in `Dockerfile.sandbox`, and Playwright Chromium is pre-baked. A stdio
server is launched directly (`npx -y <pkg>`); no gateway binary needed because the
controller is the bridge.

## Egress policy (the network question)

stdio MCP needs egress, and more broadly the agent's own code execution is more
useful with internet. Recommendation: **default-on egress, private ranges blocked**
— flip the default from "none" to a filtered "bridge", not wide-open.

- **Configured in the admin UI, not env.** DB setting `sandbox_network` =
  `none | bridge` (admin Security → Internet access), with a per-project override
  (`projects.sandboxNetwork`). The platform resolves the mode per run and passes it
  to `createSession(sessionId, userId, networkMode)`; the controller honors it
  directly (`resolveNetworkMode` — only `bridge` grants network). The old
  `SANDBOX_ALLOW_NETWORK` env gate was **removed** (redundant once the admin setting
  exists). A future `filtered` mode (private-range egress firewall) slots in here.
- `filtered` = bridge networking on a dedicated Docker network whose egress drops
  RFC1918 / link-local / `169.254.169.254` (cloud metadata) / ULA, allowing only
  public destinations. Implementation: an iptables/nft egress chain on the sandbox
  network (or a gVisor netstack policy), applied by the controller/compose. This is
  the network-layer analogue of the existing `assertSafeUrl` SSRF guard.
- `off` keeps today's hard isolation for high-security deployments.
- Per-session override stays possible (a sensitive project can force `off`).

Security note: egress enables data exfiltration by a prompt-injected agent. The
private-range block prevents pivoting into the company's internal network and
cloud metiledata; combined with gVisor's syscall isolation this matches the posture
of comparable hosted code-exec products. Document the tradeoff for operators.

## Verification (prod / Linux, gVisor + SANDBOX_ALLOW_NETWORK)

1. `filtered` egress: from a sandbox, `curl https://example.com` succeeds;
   `curl http://169.254.169.254/` and an RFC1918 address time out/refuse.
2. Add a Local connector `npx -y duckduckgo-mcp-server`; first run installs;
   `tools/list` returns; a search tool call returns results.
3. `@playwright/mcp` connects (Chromium pre-baked) and drives a page.
4. Session destroy kills the exec'd MCP process (no orphan in `docker ps`).
5. A connector with `${API_KEY}` env stays disabled until the admin sets the key.

## Open questions

- SSE vs long-poll for server→client frames (v1 can skip notifications).
- Where the egress filter lives (controller-managed nft vs a sidecar) — depends on
  whether the host allows NET_ADMIN for the controller; gVisor netstack may be cleaner.
- Per-connector network need: a connector could declare it needs egress so the UI
  can warn when `sandbox_network=off`.
