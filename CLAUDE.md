# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project overview

Capka is a self-hosted, open-source alternative to Claude's Cowork: an AI agent
that gets its own isolated Linux sandbox per chat, instead of a stateless chat
box wrapping an API. Users drop in files, and the agent writes/runs code,
converts documents, scrapes the web, and uses MCP connectors inside a
disposable Docker container. Licensed AGPL-3.0, open-core (`ee/` holds the
separate commercial edition: SSO/OIDC, SCIM, advanced RBAC, Helm — do not
conflate it with the AGPL core in `src/`).

### Who it's for (drives UI/UX decisions — see `PRODUCT.md` for the full brief)

The end user is **non-technical office staff**, not a developer — someone
drafting a document or analyzing a spreadsheet on a normal workday, with low
tolerance for jargon or anything that looks broken. A single **admin** persona
connects one shared provider key and picks the available models; everyone
else just opens a chat. This has concrete code consequences:

- Provider/model/key plumbing is an **admin-only** concern — never surface it
  to a regular user (see `resolveIsAdmin` gating in `runner.ts`, and the
  admin-only fields in the (i) popover, e.g. reasoning/cache-token counts).
  Regular users see costs and errors in plain language, not raw numbers.
  This is why so much of `src/lib/chat/` and the error-classification code in
  `src/lib/errors.ts` is split by role.
- Failure states must read as calm, role-aware sentences (user vs admin), never
  a stack trace or a bare provider error code — that's the whole point of
  `classifyLLMError` and the friendly-error machinery in `src/lib/errors/`.
- Brand personality is **calm, trustworthy, unobtrusive** — avoid the "generic
  AI SaaS" look (gradients, card-grids, eyebrow labels) and the "developer
  tool" look (terminal aesthetics, exposed jargon, mono-everywhere-density)
  when touching `src/components/`. Target WCAG 2.1 AA and honor
  `prefers-reduced-motion`.

## Commands

```bash
npm run docker:dev              # full stack (platform + postgres + sandbox-controller + socket-proxy), loopback ports + dev secrets — the normal way to develop
npm run dev                     # platform only; needs an external Postgres via DATABASE_URL
npm run build                   # production build
npm run lint                    # eslint
npx tsc --noEmit                # typecheck (no dedicated script)
npm test                        # vitest run — one pass covers src/**/*.test.ts AND sandbox-controller/*.test.js
npm run test:watch
npx vitest run path/to/x.test.ts        # a single test file
npx vitest run -t "test name substring" # a single test by name
npm run sandbox:build           # rebuild the sandbox execution image (Dockerfile.sandbox) after touching it
```

Integration tests are gated behind `RUN_INTEGRATION=1` (they need Docker/Postgres reachable).

**Schema changes**: edit `src/lib/db/schema.ts`, then `npx drizzle-kit generate`
to write a new file into `drizzle/`. Migrations apply themselves automatically
at boot (`instrumentation.ts` → `runMigrations()`) — there is no manual
`migrate` step in dev or prod. Drizzle's Postgres migrator orders migrations by
the timestamp embedded in `drizzle/meta/_journal.json`, not by filename — if a
new migration's timestamp isn't strictly greater than the existing ones, it is
silently skipped until wall-clock time catches up. A few older journal entries
carry synthetic future timestamps; check the journal after generating if a
migration doesn't seem to apply.

Editing the worker, the task runner, `instrumentation.ts`, or the Telegram bot
(`src/lib/telegram/bot.ts`) requires a container/dev-server restart — Next.js
HMR does not reload the in-process worker loop.

## Architecture

### Services

Five pieces, designed to run together on one box (`docker-compose.yml`):

| Service | Role |
|---|---|
| `platform` | The Next.js app (`src/`) — UI, API routes, and the in-process task worker share one process. |
| `postgres` | System of record **and** the realtime task queue via `LISTEN`/`NOTIFY` — no separate broker. |
| `sandbox-controller` | Plain Node.js (not the Next.js/TS build; `sandbox-controller/`) HTTP service that creates/kills per-session containers. Built hexagonally: `backends/` abstracts the compute backend (`docker-backend.js` today) behind `ComputeBackend`, `stores/` abstracts the host filesystem behind `WorkspaceStore`. It never touches the raw Docker socket. |
| `socket-proxy` | A firewall in front of the Docker API — exposes only container/exec endpoints; the host socket is mounted read-only here alone, on an isolated network. |
| `sandbox` | The execution image (`Dockerfile.sandbox`), built once and reused per session (Python, Node, Java, FFmpeg, LibreOffice, Playwright, OCR, …). |

### Task lifecycle (`src/lib/tasks/`)

Every assistant turn is a durably queued row, not an in-memory request/response:
`queue.ts` claims/leases rows, `worker.ts` is the in-process poll loop started
from `instrumentation.ts`, and `runner.ts` is the actual per-turn agent loop —
it streams from the AI SDK, dispatches tool calls into the sandbox, and
persists a snapshot after every step (`saveSnapshot`) so a crash or restart
resumes mid-task instead of losing the reply. `resume.ts`/`drain.ts` handle a
client reconnecting mid-stream; `stall-watchdog.ts` detects a stalled provider
stream and forces a retry; `delivery.ts` fans a finished turn out to non-web
channels (Telegram).

Per-turn usage/cost/context accounting lives in `messages.metadata` (jsonb),
typed in `src/lib/chat/contracts.ts`. Two usage figures are tracked and must
not be conflated: `usage.{input,output,cached}` sums across every LLM call in
a turn's tool-calling loop (correct for cost and the (i) popover), while
`contextTokens` is a snapshot of only the *last* call's prompt size (correct
for the context-window meter and the auto-compaction trigger — summing would
count a cached prefix once per step and wildly overstate how full the window
really is).

### Chat rendering (`src/lib/chat/`)

DB rows are never handed to components raw — `presenter.ts` maps them into the
UI message shape once, server-side, so message components stay dumb renderers.
`context/` holds the context-window budget and fill logic; `steps.ts` and
`tool-results.ts` shape the tool-call timeline; `stream-reconcile.ts` merges
realtime deltas onto the snapshot a client mounted with.

### Sandbox model

Sessions are keyed by `projectId ?? chatId`, so chats inside the same project
share one sandbox/workspace; a bare chat gets its own. `src/lib/sandbox/`
(`client.ts`, `tools.ts`, `workspace.ts`) is the platform-side client that
talks to `sandbox-controller` over HTTP through `socket-proxy`. Sandboxes are
unprivileged by default (`runc`, dropped capabilities, non-root); gVisor
(`runsc`) is an opt-in, fail-closed hardening tier for untrusted/multi-tenant
workloads — see `SECURITY.md` for the threat model before relying on either
boundary.

### Extensibility

`src/lib/skills/`, `src/lib/mcp/`, and `src/lib/marketplace/` implement
Anthropic-compatible skills, MCP connectors (including OAuth), and a small
plugin marketplace, gated by per-capability allow/ask/deny governance
(`src/lib/governance/`) with an audit log. Marketplace installs are pinned to
a concrete git commit; upgrades require reviewing a file-level diff before the
pin moves.

### Conventions specific to this repo

- Commits go straight to `master` — no feature branches.
- Prefer minimal, direct code: inline one-off logic rather than introducing a
  helper/constant/abstraction for a single call site, and lean on what a
  dependency already does before hand-rolling it.
- UI copy is localized via `next-intl` (`messages/*.json`); Ukrainian is a
  first-class locale, not an afterthought translation.

## Changelog conventions

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[SemVer](https://semver.org/). When a change is user- or operator-visible, add an
entry under `## [Unreleased]` in the same commit/PR — don't batch it for later.

- **Categorize**: `### Added` / `### Changed` / `### Fixed` / `### Security` /
  `### Deprecated` / `### Removed`, in that order. Only include a heading if it
  has entries; add the heading if it doesn't exist yet under Unreleased.
- **Audience**: the people who deploy and run Capka (self-hosters/admins), not
  end-users chatting with it. Reference env vars, config, files, and behavior by
  name.
- **One line per entry, not a paragraph.** State the user-visible effect and, if
  needed, the required action (env var, redeploy, migration) — that's it. No
  backstory on the old broken behavior, no internal root-cause walkthrough, no
  mechanism explanation. That detail belongs in the commit message/PR
  description, not the changelog. If an entry needs a second sentence to name a
  required action, that's the max — never three.
  - Good: "Sandbox egress under gVisor no longer kills every container
    (iptables-legacy + NET_RAW). Existing gVisor hosts: re-run
    `install-gvisor.sh` and reload Docker."
  - Bad: "Fixed a bug with sandbox egress."
  - Also bad: a multi-sentence essay on what the old firewall code did wrong,
    why, and how the fix works internally.
- **Breaking changes**: add a `> **⚠ Breaking — ...**` blockquote directly under
  the version heading (not buried in a bullet), stating exactly what breaks and
  the required action (e.g. "must set `SANDBOX_ALLOW_NETWORK=true`"). One line.
- **No marketing language, no emoji outside the ⚠ breaking-change marker.** Plain,
  precise, terse.
- Cut a release with `npm run release <x.y.z|patch|minor|major>`: it bumps
  `package.json`, renames `[Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, opens a
  fresh empty `[Unreleased]`, commits `chore(release): cut vX.Y.Z`, and tags it.
  Push `master` and the tag to publish (CI builds the images). The git tag is the
  source of truth for the running version — CI stamps it into the image as
  `CAPKA_VERSION`; `package.json.version` is kept in sync only for hygiene and is
  not read at runtime.
