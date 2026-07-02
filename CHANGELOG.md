# Changelog

All notable changes to Capka are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

> **⚠ Breaking — Coolify `docker_compose_location` must be `/docker-compose.yml`.**
> `docker-compose.coolify.yml` and `docker-compose.prod.yml` were removed;
> `docker-compose.yml` is now the single canonical pull-only stack every target
> deploys. Update the Coolify setting (Configuration → Build) and redeploy.

### Added
- **Automations: scheduled agent runs.** Users create them in chat («щопонеділка
  о 9 готуй зведення») — the agent translates the schedule, an approval card
  shows the next run dates and an estimated runs-per-month, and the platform
  then fires each run as a new ordinary chat (delivered to Telegram when
  linked) with no tab open. Runs are normal queued tasks under the user's
  budget. Three consecutive failures auto-pause the automation with a
  plain-language notice. New admin org settings: `automations_enabled`
  (default `true`), `automations_per_user` (default `10`),
  `automations_min_interval_minutes` (default `60`). New
  `/settings/automations` page lists, pauses, and deletes them; creation is
  chat-only. Adds the `automations` table (auto-migration at boot) and a
  30-second scheduler tick inside the existing in-process worker — no new
  services.
- **Connectors can now ask you for input mid-task (MCP elicitation).** An MCP
  connector that requests structured input during a tool call (`elicitation/create`)
  surfaces the same question card; your answer is handed back so the connector's
  call completes. Bounded by a ~3-minute timeout — if unanswered it auto-cancels
  and the tool call fails gracefully. Unlike the `ask` tool this does NOT survive a
  worker restart: an in-flight connector request lives on a live connection that a
  fresh worker can't reconstruct, so it's block-and-poll by design. Works on web
  (card) and Telegram (field-by-field). No operator configuration.
- **The agent can now ask you a structured question mid-task (`ask` tool).**
  Instead of guessing or answering blind when it's genuinely blocked on your
  input, the model can pause a turn to collect a choice or a short text answer
  (one field or several). The turn suspends DURABLY — it survives a worker restart
  like the native approval flow — and resumes the moment you answer. On the web a
  form card appears and the composer is blocked until you answer or skip; on
  Telegram it asks field by field (inline buttons for choices, your next message
  for text). Skipping is always allowed — the agent proceeds with a sensible
  default. No operator configuration.
- **The GitHub token for marketplace installs is now set from the UI (Settings →
  Marketplace), not only by hand-writing a `github_token` settings row.** Without
  a token, Capka calls GitHub anonymously (60 requests/hour per IP) and installs
  start failing once that budget is spent; a token raises the limit to 5000/hour
  and reaches private repos. The new admin-only field is write-only — the value
  is encrypted at rest and never echoed back (the UI shows only whether one is
  stored), matching the Telegram OIDC secret. It is deliberately NOT settable
  through the conversational `manage` tool, because a token pasted into chat would
  persist in plaintext in the message transcript.

### Changed
- **Confirming a `manage` change in chat is now native tool approval — the agent
  continues the same turn after you decide, instead of dead-ending.** Before, a
  risky change (a platform-wide setting, a connector/skill install) returned a
  `confirm_required` tool result and the turn ENDED; the agent, unable to know
  when you clicked, told you to "press Confirm" and never acknowledged the
  outcome — so the card could read "Confirmed" while the message above still said
  "press Confirm". Now the tool call SUSPENDS (AI SDK 6 human-in-the-loop
  `needsApproval`): you see one Approve/Reject card, the composer blocks until you
  decide (like Claude Code), and on Approve the tool runs and the SAME turn
  resumes so the agent confirms it's done ("Connected Context7 — 2 tools"); on
  Reject the agent is told and moves on. Applies to web and Telegram (inline
  Approve/Reject buttons that resume the turn). The gate is unchanged — personal
  prefs stay direct, platform-wide/`org` settings and third-party-code installs
  always ask, and `agent_autonomy: autonomous` still waives only personal changes.
  Undo is unchanged (a button on the applied card). No operator action required.

### Fixed
- **Adding your own provider key no longer hides the org's shared connections.**
  In `shared_plus_own`, `resolveEnabledConfigs` returned the user's own configs
  OR (only when they had none) the admin's shared configs — never both. So the
  moment a user added a personal key, every shared/public connection vanished
  from the model picker. Now the picker shows the UNION: the user's own
  connections first (a new chat still defaults to their own key, never silently
  to the admin's), followed by the admin's shared ones. Each model is tagged with
  its owning connection, so a shared-key pick is still budget-gated and now
  carries a "shared" chip; the admin's min-context / max-price caps are enforced
  on shared-connection models only (own keys stay unfiltered). No effect in
  `own_only` or `shared_only`.
- **A free (or newly released) model no longer fails with "isn't priced in the
  catalog" on the shared key.** The shared-key budget gate priced turns from the
  synced catalog only; a model the picker offered from OpenRouter's live list but
  the periodic sync hadn't captured yet had no catalog price, so `reserveBudget`
  returned `unpriced` and refused the turn — even for a genuinely free model. Now
  an unpriced model is (1) looked up against OpenRouter's live price book as a
  best-effort fallback, and (2) if still unknown, ALLOWED through with a zero hold
  (reconciled to its real, usually zero, cost at finalize) while a background
  catalog sync is kicked to price it next time — instead of being blocked. A
  model is never hidden or refused for missing a price. With no `github_token` configured, Capka calls the
  GitHub API anonymously (60 requests/hour per IP); once that budget was spent,
  `resolveCommit`/`ghTree`/`ghRaw` threw a bare `HTTP 403`, which the agent
  relayed to users as "доступ заборонено" — reading as a permissions problem
  rather than a temporary limit. GitHub failures now surface as actionable
  sentences: an exhausted anonymous rate limit says how long until it resets and
  that an admin can configure a GitHub token; a 404 says the repo is missing or
  private; a 401 says the token was rejected. Configure `github_token` (settings
  row) to raise the limit to 5000/hour.
- **An OAuth MCP connector now works right after you sign in, instead of being
  silently ignored for up to 10 minutes.** Adding an OAuth connector and then
  signing in left the agent unable to use it: any turn between adding and
  signing in eagerly tried to connect the connector, got the expected 401, and
  recorded a 10-minute connect-error backoff. A successful OAuth callback did
  not clear that backoff, so the next turn's `loadMcpTools` skipped the
  connector — the model had none of its tools and answered from memory, even
  though the connector's own diagnostics reported it healthy. Three changes:
  `loadMcpTools` no longer eager-connects (or records an error for) an OAuth
  connector with no stored token — an unauthenticated 401 is "not signed in
  yet", not a failure; the OAuth callback clears the connect backoff on success
  (covering the token-revoked-then-reauthorized case); and the connectors list
  shows "sign-in needed" only when a token is actually missing, not for every
  OAuth connector. Confirming an OAuth connector in chat now also surfaces its
  "Connect" sign-in button inline in the confirmation card, and a cancelled
  confirmation reads as "cancelled" (not "expired") after a reload.
- **The agent no longer refuses config changes it's actually allowed to make.**
  A weak model would read a control's `requiredRole: "admin"` label (or the
  `members_can_install_plugins` setting) and pre-emptively refuse — telling an
  admin "you're only a regular user, ask your admin" — without ever calling the
  action. The `manage` tool now decides permission entirely from the action's
  result: `list`/`capabilities` no longer expose role/scope labels, and the
  prompt directs the model to CALL the action and only refuse on an actual
  `error` result. Non-admin connector/skill installs now correctly honour
  `members_can_install_plugins` server-side (admins always may).

### Changed
- **`manage` results in chat are cards only when the user must still act; the
  rest drop to the quiet activity rail.** Applied settings, enable/disable, healthy
  connector diagnostics, and internal reads (a value, the registry list, a
  collection's items) all rendered as prominent cards, so a short exchange piled up
  a stack of "Setting updated" / "Diagnostics: ok" boxes that just echoed what the
  tool already recorded. Now a card appears only for something still awaiting the
  user: a confirmation, a chip picker, an OAuth/open-url hand-off, a locale switch
  (which must refresh the page), or a diagnostic/added-connector that carries a
  sign-in button. Everything else shows as a one-line rail step (its localized
  summary — "Sandbox network → Isolated", "firecrawl: working"), so the timeline
  reads cleanly instead of as a wall of result cards.
- **All `manage` user-facing text is English in code + localized via i18n
  (default English).** Control titles, values, states and messages were
  Ukrainian string literals; they are now English in the source (the single
  source of truth and fallback) and translated through `messages/<locale>.json`
  under a new `manage` namespace, resolved server-side to the user's locale.
  Values render as words, not raw codes (e.g. sandbox network shows "Network
  access", not `bridge`). i18n keys are derived from the control id, so a missing
  translation falls back to English rather than breaking — guarded by tests that
  fail if a control lacks a Ukrainian title. The audit log ("Activity") now
  labels `settings.update`/`settings.undo` instead of showing the raw code.

### Added
- **The agent can install and edit skills from the workspace without burning
  tokens re-typing them.** Previously a skill could only be added by pasting a
  whole SKILL.md into the tool call, or from a GitHub repo; a skill a user dropped
  into the sandbox as files or a `.zip` had to be read and echoed back in full.
  Now `manage skill add {path}` points at a workspace path — a SKILL.md, a skill
  folder, a repo-shaped `skills/<name>/` tree, or a `.zip` — and the platform reads
  the bytes server-side (zips unzipped in-process, bomb-guarded). `manage skill
  edit {name}` checks a skill out to `.capka/skills/<name>/` so the agent edits it
  with ordinary file tools and saves back via `add {path}` (an in-place upsert),
  instead of re-authoring the whole file. Governance/confirm are unchanged — the
  same authorization and (supervised) confirmation apply at the add.
- **`agent_autonomy` setting (admin): "supervised" (default) or "autonomous".**
  In supervised mode the agent stages a risky change and the user approves it on a
  confirmation card, as before. In autonomous mode the agent applies *personal*
  changes directly from chat and keeps working — no card, no round-trip. Undo and
  the audit log apply in both modes. Set it from chat or the settings UI.
- **Conversational settings control plane — users and admins manage config from
  chat via a new `manage` agent tool.** A regular user can change their own
  preferences (interface language, timezone); an admin can additionally change
  platform-wide settings (`platform_name`, `sandbox_enabled`, `sandbox_network`,
  `block_private_provider_urls`, `share_admin_providers`,
  `members_can_install_plugins`, `update_check_enabled`, `model_min_context`,
  `max_context_tokens`, `model_max_price`) — all in plain language, no settings
  page required. Role is enforced server-side from the session identity (never
  the model's arguments): a non-admin cannot even see, let alone change, org
  settings. Risky org-wide changes are two-phase and the confirmation is a real
  security boundary, not a prompt: the agent can only STAGE a change (server-side,
  single-use, 10-minute TTL, bound to the user); it never receives a token it
  could replay. Only the user's own click — the web Confirm button (session
  cookie) or a Telegram inline button (callback) — applies it, so a
  prompt-injected agent in an admin session cannot self-confirm a change (e.g.
  disable the SSRF guard). The exact staged mutation is stored, so a confirmed
  change can't be swapped for a different one. Every change is recorded in the
  audit log (`settings.update` / `settings.undo`) and is reversible via an Undo
  that travels the same human-authed path. The existing `/settings` pages are
  unchanged and remain the alternative.
- **MCP connectors are now manageable from chat too.** The `manage` tool gained a
  collection abstraction: `get mcp` lists connectors; `add`/`remove` (confirm-gated),
  `enable`/`disable`, `debug` (live reachability/auth probe) and `connect` operate
  on them. Connectors needing a browser sign-in (OAuth) return an
  `action_required` result with a URL — rendered as a Connect button in web / a
  link in Telegram — since the agent can't perform the redirect itself; the
  existing `/api/mcp/oauth/start` flow is reused. A personal remote connector can
  be added by any user; local (stdio) and org-wide connectors remain admin-only,
  enforced server-side. Secrets are never entered through chat — a token-auth
  connector is still configured on the settings page.
- **Agent skills are manageable from chat as well.** `get skill` lists skills;
  `add` ingests a SKILL.md the agent composes (frontmatter name/description +
  body), `enable`/`disable`/`remove` operate on them. Personal skills are open to
  any user; org-wide skills are admin-only, enforced server-side. Same collection
  abstraction as connectors — new manageable resources are a registration, not a
  dispatcher change.
- **`manage` UX round: first-run concierge, chip pickers, popup OAuth, connector
  probe, instant locale, cross-links, and an admin-change banner.** After setup,
  the admin's first chat turn greets them and offers to configure the optional
  bits (language, Telegram, a first connector) — a one-time nudge, not a wizard
  (setup stays a form since the agent can't run before a provider key exists).
  Reading an enum/boolean setting now shows its values as pickable chips; adding
  a remote connector probes it first ("responds — N tools" / "couldn't reach
  it") so nobody confirms blind; OAuth sign-in opens in a popup that closes and
  re-checks itself (falls back to full-page redirect if blocked); changing the
  interface language takes effect immediately (no manual reload); connector/skill
  cards link to the full settings page and vice-versa; and when one admin changes
  a platform-wide setting, other admins see a calm, dismissible banner on their
  next visit.
- **The chat confirm preview is now identical on every channel.** The staged-change
  confirmation is only a real security boundary if the user sees what they're
  approving — but the Telegram preview dropped the impact warning and a skill's
  full body, the plain-text fallback dropped the before→after diff, and the web
  Cancel was cosmetic (it hid the buttons but left the staged change live on the
  server, so a reload re-offered it). All three are fixed: impact + body travel to
  Telegram, the plain-text fallback carries the full preview, and web Cancel drops
  the pending server-side. Web and Telegram apply through one canonical server path.
- **`PLATFORM_BIND` env var to bind the platform port to a single interface.**
  Defaults to `0.0.0.0` (all interfaces — works out of the box). Set
  `PLATFORM_BIND=127.0.0.1` to publish loopback-only when a reverse proxy fronts
  the app — recommended on hosts where Docker publishes past the firewall (UFW).
- **CI (`.github/workflows/ci.yml`)** runs typecheck, lint, tests and a build on
  every push and pull request.

### Changed
- **One canonical `docker-compose.yml` replaces the three near-duplicate stack
  files.** Previously `docker-compose.yml` (build), `docker-compose.prod.yml`
  (pull-only copy) and `docker-compose.coolify.yml` (host-nginx copy) each carried
  the full four-service stack and had to be hand-synced — and had already drifted.
  Now there is one pull-only `docker-compose.yml` that every target deploys
  (self-host and Coolify alike); building from source moved to an opt-in overlay
  `docker-compose.build.yml`, layered by `CAPKA_BUILD=1` and `npm run docker:dev`.
  `npm run docker:prod` is now `docker compose up -d` (pull), not `up --build`.

### Fixed
- **Coolify deploys regain their sandbox tuning and redeploy drain, silently lost
  in the earlier move to `docker-compose.prod.yml`.** That file shipped without the
  controller tuning and `stop_grace_period` the old `coolify.yml` carried, so prod
  fell back to the controller's lighter code defaults: 512 MB per sandbox (not
  1 GB — risky, since the sandbox tmpfs is charged to the same cgroup), 5 sessions
  per user (not 2), a 1 h orphaned-dir GC grace (not 7 d) and no worker-drain grace
  on redeploy (in-flight turns were SIGKILLed mid-run). These are now explicit
  `${VAR:-…}` defaults in `docker-compose.yml` (`SANDBOX_MEMORY_MB=1024`,
  `MAX_SESSIONS_PER_USER=2`, `GC_GRACE_MS=604800000`, …) with `stop_grace_period:
  35s` restored, all overridable from the Coolify environment.

### Security
- **Platform-wide settings always require confirmation, even in autonomous mode.**
  With `agent_autonomy=autonomous`, the agent applied *any* risky change directly,
  including org-scoped settings that affect every user (e.g. `sandbox_network`,
  `block_private_provider_urls`) — so a misread request or a prompt injection could
  silently disable network isolation or the SSRF guard platform-wide, with only a
  post-hoc Undo. Autonomy now covers personal changes only: a control with
  `scope: "org"` is always staged to a confirmation card regardless of autonomy
  mode (the dispatcher gates on scope, so every current and future org control
  inherits this). Personal preferences and skill installs still apply directly in
  autonomous mode. No change in supervised mode.

### Removed
- **Fly.io and Railway deploy manifests (the `deploy/` directory) removed.** They
  deployed the platform only (no Docker daemon → no code sandbox), which isn't a
  supported configuration. Self-host via the installer or Coolify; the Coolify
  how-to moved into `DEPLOY.md`, now the single deploy guide.

## [0.1.6] - 2026-07-01

### Fixed
- **Cerebras gpt-oss (and similar reasoning models) now complete a tool-calling
  turn instead of hanging.** v0.1.5 fixed the `reasoning_content` 400 by
  *removing* the echoed reasoning — but Cerebras' gpt-oss is a reasoning model
  that needs its own prior thinking to continue a tool-calling turn, so dropping
  it entirely just traded the 400 for a silent 60s-per-attempt stall until the
  turn failed. Per Cerebras' own docs, prior reasoning must be retained by
  prepending it into the assistant message's `content` (not the `reasoning_content`
  field, which it rejects on input). The recovery now *folds* reasoning into
  content instead of dropping it: no `reasoning_content` on the wire (no 400) and
  the thinking is preserved (no stall). Still reactive (only after a rejection),
  so DeepSeek — which requires the field passed back verbatim — is untouched.

## [0.1.5] - 2026-07-01

### Fixed
- **Reasoning models behind an OpenAI-compatible endpoint now survive a
  tool-calling turn too, not just plain multi-turn chat.** The v0.1.4 fix stripped
  the echoed `reasoning_content` only from the input history (`modelMessages`),
  which covered a multi-turn chat but not a turn that calls a tool: with tools,
  the offending echo is an *intermediate* assistant message that the AI SDK
  generates and re-feeds inside its own tool loop (`streamText` step 2+), so it
  never appears in the history we strip — the request still 400'd with
  `messages.N.assistant.reasoning_content … is unsupported` (seen on Cerebras
  `gpt-oss-120b` via LiteLLM the moment the model used a connector like Firecrawl).
  The strip is now also applied per-step in `prepareStep`, so reasoning is removed
  from every intermediate tool-loop message as well. Still reactive (only after an
  actual rejection) so DeepSeek, which requires the field, is untouched.

## [0.1.4] - 2026-07-01

### Changed
- **A large MCP connector result no longer floods the context window or the
  database.** A connector is untrusted and can return an arbitrarily large text
  blob or a multi-megabyte base64 image/file; previously the text was clamped for
  the model but the *full* result (including whole media blobs) was still
  persisted to Postgres and re-sent to the model every turn — real cost, and a big
  enough blob could trip the reactive `context_too_long` recovery. Now every MCP
  result is bounded at the moment it is produced: oversized **text** is parked in
  the session workspace (`/workspace/.capka/output/mcp/`, off-disk via the
  controller file API — no container needed) and the model gets a clamped view
  that points at the file to `read_file`/grep, exactly like the sandbox
  capture-to-file logs; an oversized **image/audio/file** blob (over
  `MAX_MCP_MEDIA_BYTES`, default 5 MB) is likewise parked and replaced with a
  text pointer the model can process programmatically (OCR/ffprobe/convert)
  instead of being inlined. Tune with `MAX_MCP_MEDIA_BYTES` and the existing
  `MAX_TOOL_OUTPUT_CHARS`.
- **MCP tool descriptions are now capped** at `MAX_MCP_TOOL_DESC_CHARS` (default
  1024) before they reach the model. Some servers ship enormous per-tool
  descriptions that tax the context of *every* call before any tool even runs.
- The "update available" banner is now **dismissible** — a close button hides it
  and remembers the release, so it stays gone for that version but returns when a
  newer one ships (it previously reappeared on every page load with no way to
  silence it).
- Release notes on **Settings → Updates** now render as Markdown (via the same
  renderer the chat uses) instead of raw preformatted text, and the "how to update"
  hint is trimmed.

### Fixed
- **Reasoning models behind an OpenAI-compatible endpoint (Cerebras via a LiteLLM
  proxy, etc.) no longer die on the second turn.** The `@ai-sdk/openai-compatible`
  adapter echoes a model's own prior `reasoning_content` back into the request
  history (vercel/ai#15042); some backends accept that field only on output and
  reject it on input, so any tool-calling or multi-turn chat 400'd with
  `messages.N.assistant.reasoning_content: property … is unsupported`. The runner
  now detects that specific rejection and re-streams once with reasoning stripped
  from the historical assistant turns (the DB/UI transcript keeps it — only the
  model's view drops it). Reactive by design: because the backend is opaque behind
  a LiteLLM proxy, it only strips after a rejection, so DeepSeek — which *requires*
  `reasoning_content` passed back — is never touched. Setting LiteLLM's
  `merge_reasoning_content_in_choices` does not fix this: Capka re-extracts inline
  `<think>` back into reasoning parts, so the field returns on the next turn.
- **The context-window "full" meter and auto-compaction no longer overstate usage
  on multi-step turns.** A turn that makes several LLM calls (a tool-calling loop)
  re-reads the same growing prefix from cache on every step; `usage.input`/
  `usage.cached` correctly sum that across steps for cost and the (i) popover, but
  the context meter and the compaction trigger were reusing the same cumulative
  sum to represent "how full is the window" — so a 9-step turn could show up to 9x
  its real size, and compaction could fire well before the window was actually
  full. Both now key off the last step's actual prompt size instead.

## [0.1.3] - 2026-07-01

### Fixed
- **Completes the gVisor egress fix** (0.1.2 was still partial). Two more pieces,
  both automatic — **no config/env change needed**:
  - iptables-legacy needs a writable lock, but the sandbox rootfs is read-only and
    `/run` isn't a writable mount, so the firewall died on `/run/xtables.lock`. The
    controller now points it at the writable `/tmp` tmpfs (`XTABLES_LOCKFILE`),
    set automatically only when egress is on.
  - a crashed sandbox container left its fixed name behind, so recreating the
    session failed with a 409 name conflict forever. The controller now
    force-removes the stale husk and retries.

## [0.1.2] - 2026-07-01

### Fixed
- **Sandbox egress under gVisor no longer kills every container.** With
  `SANDBOX_ALLOW_NETWORK=true` on the `runsc` profile, the fail-closed egress
  firewall (added in 0.1.0) could not install its iptables rules and exited the
  container the instant it started — so every command failed. Three pieces were
  needed: the image pins iptables to the **legacy** backend gVisor speaks (not
  nft); the controller grants the sandbox **NET_RAW** alongside NET_ADMIN so the
  rules' `filter` table can initialize under `CapDrop: ALL`; and
  `scripts/install-gvisor.sh` registers the runtime with **`--net-raw=true`** so
  gVisor honors that capability. **Existing gVisor hosts must re-run the install
  script (or add `--net-raw=true` to the runsc `runtimeArgs`) and reload Docker.**
- Controller now recovers from a present-but-stopped sandbox container, not only a
  removed one: a stale handle is invalidated so the session is recreated instead of
  looping on "container is not running".

## [0.1.1] - 2026-07-01

Partial gVisor egress fix (legacy iptables backend in the image + the
`--net-raw=true` install step) — **superseded by 0.1.2**, which adds the missing
`NET_RAW` container capability without which the firewall still fails. Use 0.1.2.

## [0.1.0] - 2026-06-30

> **⚠ Breaking — sandbox network egress is now fail-closed.** Sandboxes have
> **no outbound network** unless you explicitly set `SANDBOX_ALLOW_NETWORK=true`.
> Deployments that relied on sandboxes reaching the internet (package installs,
> scraping, outbound API calls from agent code) **must add this variable** or that
> traffic silently stops. This closes an egress-by-default hole; opt back in only
> if you understand the exposure (see `SECURITY.md`).

### Added
- AGPL-3.0 license; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, CLA.
- One-variable automatic HTTPS via the Caddy TLS overlay (`DOMAIN=…`).
- Railway and Coolify deploy templates.
- Postgres backup/restore scripts and an optional scheduled-backup overlay.
- `CAPKA_VERSION` image pinning and an upgrade runbook (`docs/UPGRADE.md`).
- `ee/` boundary reserved for the commercial edition.
- Marketplace install review: every plugin install is **pinned to a concrete git
  commit** (provenance recorded), all third-party code execution is **disabled by
  default** pending admin review, and upgrades show a **file-level diff bound to the
  reviewed commit** before the pin is moved.
- Boot-time configuration audit: misconfigured/missing env (master key,
  `DATABASE_URL`, public URL, numeric knobs) is surfaced as one block at startup.
- A Content-Security-Policy (the inline-safe slice: `object-src`, `base-uri`,
  `form-action`, `frame-ancestors`).

### Changed
- The host-agnostic `docker-compose.yml` is now the canonical compose; the
  Coolify variant moved to `docker-compose.coolify.yml` (no longer auto-selected).
- `docker compose pull` now fetches the sandbox image from GHCR too.
- Sandbox image: base image is an overridable `UBUNTU_REF` arg and the duckdb/yq
  CLIs are pinned to explicit versions (were `releases/latest`, non-reproducible).

### Security
- **Sandbox egress fail-closed** behind `SANDBOX_ALLOW_NETWORK` (see breaking note
  above); the egress firewall refuses to start if its rules can't be verified.
- Governance `ask` now fails **safe** (deny) instead of allowing.
- SSRF guard broadened (0.0.0.0 / multicast / IPv6) and strips `Authorization`/
  `Cookie` on cross-host redirects; the private-range block is threaded into the
  inference fetch path. (Full DNS-rebind IP-pinning is still pending — see
  `SECURITY.md` → Known limitations.)
- Zip uploads get a decompression-bomb guard: entries inflate under a hard
  `maxOutputLength` cap, so a lying header can't expand a small upload to gigabytes.
- Foreign keys + money-column precision added (`drizzle/0034`, `0035`); audit log
  extended to admin role/status/remove, auth-config, and master-key actions.
- Billing holds are always released (try/finally); first-run setup can no longer be
  hijacked to self-promote admin; pending accounts are rejected centrally.
- Dependency advisories pinned where a non-breaking fix exists: `postcss` ≥8.5.10
  (CSS-stringify XSS) and `dompurify` ≥3.4.11 via `overrides` (was 12 prod
  advisories, now the remainder are dev-tooling only — see `SECURITY.md`).
- Account status is fail-closed (only "active" grants access); marketplace upgrade
  consent is fail-closed (must target the reviewed commit); MCP connector mutations
  require an approved account; one billing hold per task (partial unique index);
  marketplace raw fetches and catalog size are byte/count-capped.
- **Production master key is fail-closed**: with `NODE_ENV=production` and no
  `CAPKA_MASTER_KEY`, the app now refuses to start rather than silently storing the
  key in the DB. Set `CAPKA_MASTER_KEY` (recommended) or `ALLOW_DB_MASTER_KEY=true`
  to knowingly keep the insecure fallback. (`npm run up` already generates the env
  key, so turnkey deploys are unaffected.)
- HSTS is now sent by the platform too, not only the Caddy TLS profile.
