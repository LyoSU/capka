# Changelog

All notable changes to Capka are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Attach a server folder to a chat's sandbox at `/folders/<name>` via the `manage`
  tool (or a chat request). Gated by the new org setting `folder_access` (default
  `off`; `admins`/`everyone`) — server folders are admin-only and confirm-gated,
  read-only by default. Set `SANDBOX_MOUNT_ALLOW` (`:`-separated roots) to restrict
  mountable paths; recommended for multi-admin hosts. See SECURITY.md.

## [0.2.4] - 2026-07-03

### Fixed
- Regenerating or editing a message after switching the model now runs the newly
  selected model instead of the chat's previously persisted one.
- Destructive confirm buttons (delete skill, delete automation) now show readable
  light text — `text-destructive-foreground` was missing from the theme, so the
  label fell back to dark text on the red background.
- With classic scrollbars (Windows/Linux), the app no longer reserves a dead
  15px strip along the right window edge; the chat column stays centered via a
  symmetric scrollbar gutter, and the workspace files panel opens flush with the
  window edge without clipping its content mid-animation.

### Changed
- Admin top banners (update available, provider out-of-credits/invalid-key, org
  change) share one calm muted style instead of a full-width amber alarm, and all
  three are now dismissible. The out-of-credits/invalid-key banner re-appears if
  the problem recurs after being resolved.
- The "model can't read this attachment" chat notice is now a quiet inline hint,
  reworded to clarify the model can't view the file directly (not that it failed).

## [0.2.3] - 2026-07-03

### Changed
- **Telegram: the turn summary (reasoning `<details>` / tool log) moved below
  the answer** — the streamed reply now finishes by typing out the footer
  instead of visibly repainting the whole message to insert a header.

## [0.2.2] - 2026-07-03

### Fixed
- **Telegram: the streamed draft no longer lingers as a "still thinking" bubble
  for ~30s next to the delivered answer** — the final message is now bridged
  into the draft so Telegram clients adopt it cleanly.
- **Pasting two screenshots no longer collapses them into one attachment** —
  clipboard bitmaps all arrive named `image.png`, so the second overwrote the
  first in the sandbox and the dedup-by-name persistence treated them as one.
  Pasted images now get a unique name; real copied filenames are left untouched.

## [0.2.1] - 2026-07-02

### Fixed
- **One-off automations (`once_at`) now fire at the user's wall-clock time, not
  the worker's UTC clock** — a "22:15" one-off scheduled 22:15 UTC before, so it
  ran hours off. One-off triggers now carry a timezone.
- **An approved `manage` action (e.g. creating an automation) could apply twice
  when the turn hit a provider retry** — the tool now executes at most once per
  call, so retries no longer duplicate the change.
- **The scheduler no longer silently drops an occurrence when firing fails** — a
  failed fire restores the due time to retry and counts toward the 3-failure
  auto-pause instead of leaving a one-off disabled with no run.
- **Settings → Automations shows the scheduler's real next-run time and flags an
  overdue run** (background worker not running) instead of a recomputed date that
  hid a stuck worker.
- **`/api/automations/:id` (enable/disable) rejects a non-boolean body** instead
  of coercing e.g. the string `"false"` to `true`.
- **A created automation now runs on the model of the chat that created it**
  (was always the account default), and due automations fire immediately on
  worker start instead of waiting up to 30s.
- **A Coolify redeploy on an unchanged image tag (`:latest` or a pinned
  `CAPKA_VERSION`) no longer keeps running the previously cached image bits**
  — `platform` and `sandbox-controller` now set `pull_policy: always`, so
  `docker compose up -d` re-checks the registry every deploy instead of only
  pulling when the tag is missing locally.
- **Settings → General "About" and the MCP client handshake now report the
  actual running version** (`CAPKA_VERSION`) instead of a frozen `package.json`
  number that never moved past `0.1.0`.

## [0.2.0] - 2026-07-02

> **⚠ Breaking — Coolify `docker_compose_location` must be `/docker-compose.yml`.**
> `docker-compose.coolify.yml`/`.prod.yml` were removed; update the Coolify
> setting (Configuration → Build) and redeploy.

### Added
- **Automations**: schedule recurring agent runs from chat (e.g. «щопонеділка о
  9 готуй зведення»); each run is a normal chat, delivered to Telegram when
  linked; 3 consecutive failures auto-pause. Admin settings:
  `automations_enabled`, `automations_per_user` (10), `automations_min_interval_minutes`
  (60). New `/settings/automations` page.
- **MCP elicitation**: a connector can ask a structured question mid-tool-call;
  ~3 min timeout, does not survive a worker restart (unlike `ask`).
- **`ask` tool**: the agent can pause a turn to ask you a question; durable
  across worker restarts; web card or Telegram field-by-field; always
  skippable.
- **GitHub token for marketplace installs** now configurable from Settings →
  Marketplace (write-only, encrypted) — raises the anonymous API rate limit
  (60/hr) to 5000/hr and reaches private repos.
- **Agent can install/edit skills straight from workspace files or a `.zip`**
  (`manage skill add {path}` / `edit {name}`) instead of pasting a whole
  SKILL.md into the tool call.
- **`agent_autonomy` setting** (admin): `supervised` (default, confirm cards)
  or `autonomous` (personal changes apply directly; org-wide changes still
  confirm).
- **Conversational settings (`manage` tool)**: users change personal prefs and
  admins change platform-wide settings from chat. Org-wide changes are
  two-phase (staged server-side, applied only by your own click), audit-logged,
  and undoable.
- **MCP connectors and skills manageable from chat** via the same `manage`
  collection (list/add/remove/enable/disable/debug/connect); OAuth connectors
  hand back a Connect link.
- **`manage` UX polish**: first-run concierge nudge, chip pickers for
  enum/boolean settings, popup OAuth, a reachability probe before confirming a
  new connector, instant locale switching, and a banner when another admin
  changes something.
- **`PLATFORM_BIND` env var** (default `0.0.0.0`) to bind the platform port to
  one interface, e.g. `127.0.0.1` behind a reverse proxy.
- **CI** (`.github/workflows/ci.yml`): typecheck, lint, tests, build on every
  push/PR.

### Changed
- **The `manage` tool description shed its per-collection reference (~40%
  smaller), cutting its per-turn token cost.** Connector/skill/automation add
  shapes and workflows now come back as a `usage` field from `get` on the
  collection (and are echoed on an invalid `add`), instead of riding along in
  every request. Malformed `manage` calls now name the missing fields, and an
  `add` whose args can't validate is rejected immediately instead of first
  asking you to approve it.
- **Claude models now cache the conversation history, not just the system
  prompt** — long Claude chats bill at roughly cache-read pricing instead of
  full price. Claude behind a LiteLLM proxy still needs
  `cache_control_injection_points` configured on the proxy.
- Chat-title generation no longer burns reasoning tokens on thinking models.
- **`manage` confirmations use native tool approval** — the turn resumes after
  you Approve/Reject instead of dead-ending.
- **`manage` chat replies show a card only when you still need to act**;
  routine results (applied settings, healthy diagnostics) drop to a one-line
  activity-rail entry instead of stacking as cards.
- **`manage` text is now localized via i18n** (English source of truth,
  `messages/<locale>.json`); a missing translation falls back to English
  instead of breaking.
- **One canonical `docker-compose.yml`** replaces the three near-duplicate
  stack files; building from source is now the opt-in
  `docker-compose.build.yml` overlay (`CAPKA_BUILD=1`).

### Fixed
- **Adding your own provider key no longer hides the org's shared
  connections** — the model picker now shows the union of your own and shared
  connections instead of only one or the other.
- **A free or newly-released model no longer fails with "isn't priced in the
  catalog"** on the shared key — falls back to OpenRouter's live price book,
  or is allowed through with a zero hold if still unpriced.
- **GitHub rate-limit/404/401 errors now read as plain-language messages**
  (e.g. "rate limit resets in Xm, ask your admin for a token") instead of
  "access denied".
- **An OAuth MCP connector now works immediately after sign-in**, instead of
  being silently ignored for up to 10 minutes.
- **The agent no longer refuses config changes it's actually allowed to
  make** — permission is now decided by the action's result, not by the model
  pre-emptively reading role labels.
- **Coolify deploys regain sandbox tuning and redeploy drain** lost when
  `docker-compose.prod.yml` was introduced (1 GB sandbox memory, 2
  sessions/user, 7-day GC grace, 35s `stop_grace_period`).
- **An automation run that stops to ask a question no longer piles up
  duplicate runs** on the next scheduled occurrence.
- **The skill-install approval card now lists the actual skills** a workspace
  path would install, instead of falling back to "couldn't read that path".

### Security
- **Platform-wide (org-scope) settings always require confirmation**, even in
  `agent_autonomy: autonomous` mode.
- **Enabling a connector, skill, or automation from chat now requires
  approval**, same as adding one (`disable` stays direct).
- **The automations API now rejects pending/rejected accounts**, not just
  unauthenticated ones.
- **A workspace skill `.zip` install is now size-capped while streaming**, not
  only at upload.
- **A double-tapped approval/answer, or racing web + Telegram responses, can
  no longer fire a turn twice.**
- **A late Telegram reply to a timed-out connector question** is no longer
  swallowed or falsely reported as answered.

### Removed
- **Fly.io and Railway deploy manifests** (`deploy/`) — platform-only deploys
  aren't supported; self-host via the installer or Coolify (guide moved to
  `DEPLOY.md`).

## [0.1.6] - 2026-07-01

### Fixed
- **Cerebras gpt-oss (and similar reasoning models) no longer hang mid-turn**
  — prior reasoning is now folded into the assistant message's `content`
  instead of dropped, which was trading the earlier 400 for a silent stall.

## [0.1.5] - 2026-07-01

### Fixed
- **Reasoning models behind an OpenAI-compatible endpoint now survive
  tool-calling turns, not just plain chat** — the `reasoning_content` strip
  now also applies per tool-loop step, not only to the initial history.

## [0.1.4] - 2026-07-01

### Changed
- **Oversized MCP results (text or media) no longer flood the context window
  or the database** — parked to workspace storage with a pointer the model can
  `read_file`/grep. Tune with `MAX_MCP_MEDIA_BYTES` / `MAX_TOOL_OUTPUT_CHARS`.
- MCP tool descriptions capped at `MAX_MCP_TOOL_DESC_CHARS` (default 1024).
- Update-available banner is now dismissible per version; release notes render
  as Markdown.

### Fixed
- **Reasoning models behind an OpenAI-compatible endpoint (e.g. Cerebras via
  LiteLLM) no longer die on the second turn** — echoed `reasoning_content` is
  stripped after a rejection; DeepSeek (which requires the field) is untouched.
- The context-window meter and auto-compaction no longer overstate usage on
  multi-step turns — now keyed off the last step's prompt size, not the
  cumulative sum.

## [0.1.3] - 2026-07-01

### Fixed
- **Completes the gVisor egress fix** (0.1.2 was partial) — iptables lock
  moved to writable `/tmp`, stale sandbox container names are force-removed on
  conflict. No config change needed.

## [0.1.2] - 2026-07-01

### Fixed
- **Sandbox egress under gVisor no longer kills every container**
  (iptables-legacy + `NET_RAW` capability + `--net-raw=true` runtime flag).
  **Existing gVisor hosts must re-run `install-gvisor.sh` and reload Docker.**
- Controller now recovers from a stopped (not just removed) sandbox container.

## [0.1.1] - 2026-07-01

Partial gVisor egress fix — **superseded by 0.1.2**, which adds the missing
`NET_RAW` capability. Use 0.1.2.

## [0.1.0] - 2026-06-30

> **⚠ Breaking — sandbox network egress is now fail-closed.** Set
> `SANDBOX_ALLOW_NETWORK=true` if sandboxes need outbound network access.

### Added
- AGPL-3.0 license; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, CLA.
- One-variable automatic HTTPS via the Caddy TLS overlay (`DOMAIN=…`).
- Railway and Coolify deploy templates.
- Postgres backup/restore scripts and an optional scheduled-backup overlay.
- `CAPKA_VERSION` image pinning and an upgrade runbook (`docs/UPGRADE.md`).
- `ee/` boundary reserved for the commercial edition.
- Marketplace installs are pinned to a concrete git commit, disabled by
  default pending admin review, and upgrades show a file-level diff before the
  pin moves.
- Boot-time configuration audit surfaces misconfigured/missing env as one
  block at startup.
- A Content-Security-Policy (the inline-safe slice).

### Changed
- The host-agnostic `docker-compose.yml` is now canonical; the Coolify variant
  moved to `docker-compose.coolify.yml`.
- `docker compose pull` now fetches the sandbox image too.
- Sandbox image base and duckdb/yq versions are pinned (were `latest`).

### Security
- Sandbox egress fail-closed behind `SANDBOX_ALLOW_NETWORK` (see breaking note
  above); the egress firewall refuses to start if its rules can't be verified.
- Governance `ask` now fails safe (deny) instead of allowing.
- SSRF guard broadened (0.0.0.0/multicast/IPv6) and strips
  `Authorization`/`Cookie` on cross-host redirects.
- Zip uploads get a decompression-bomb guard.
- Foreign keys + money-column precision added; audit log extended.
- Billing holds always release; first-run setup can no longer self-promote
  admin; pending accounts are rejected centrally.
- Pinned `postcss` ≥8.5.10 and `dompurify` ≥3.4.11 (prior advisories).
- Account status and marketplace upgrade consent are fail-closed; one billing
  hold per task; marketplace fetches/catalog size are capped.
- **Production master key is fail-closed**: with `NODE_ENV=production` and no
  `CAPKA_MASTER_KEY`, the app refuses to start. Set `CAPKA_MASTER_KEY` or
  `ALLOW_DB_MASTER_KEY=true` to keep the insecure fallback.
- HSTS is now sent by the platform too, not only the Caddy TLS profile.
