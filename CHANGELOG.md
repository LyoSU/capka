# Changelog

All notable changes to Capka are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.9.1] - 2026-07-13

### Changed
- The model is now instructed to analyze delivered attachments from the inline content it already has, instead of re-reading or transcoding them with sandbox tools.
- Attachment delivery decisions are now logged (provider, model, and per-file MIME type) to diagnose whether a given file was sent natively.

### Fixed
- Google/Gemini attachments no longer produce oversized inline requests: audio, video, and PDF files over ~13 MiB now go to the agent's file tools instead of exceeding Gemini's 20 MB request cap.

## [0.9.0] - 2026-07-13

### Added
- Share-link import now also handles Gemini (`share.gemini.google` / `gemini.google.com/share`) and Grok (`grok.com/share`), alongside Claude and ChatGPT; still experimental and gated behind `CAPKA_SHARE_IMPORT`.

### Changed
- Refined English and Ukrainian interface copy for clearer terminology, more natural punctuation, and correct singular and plural forms.

### Fixed
- Attached photos are now normalized in the sandbox before the model sees them: EXIF orientation is baked into the pixels (no provider auto-rotates, so sideways phone photos were the top "the model can't read my image" cause), HEIC/HEIF/TIFF/BMP/AVIF are converted to JPEG (providers accept only JPEG/PNG/GIF/WebP — sending these raw returned a provider error), CMYK is converted to sRGB, and oversized images are downscaled by dimension rather than only by byte size. An image whose format can't be delivered (e.g. SVG) is routed to the agent's file tools instead of being wrongly reported as unreadable. The user's original file stays untouched in the workspace.
- Attached images are placed before the prompt text in the request, matching provider guidance for image understanding.
- Share-import commit is now rate-limited per user (429) and idempotent (a retried or double-clicked import reuses the created chat instead of duplicating it), and rejects oversized request bodies (413).
- Share-import parsers now whitelist message roles strictly (an unknown sender is dropped, not treated as the assistant) and guarantee the imported history starts with a user turn; ChatGPT shares without a `current_node` follow one deterministic branch instead of mixing branches.
- One-shot import sandboxes (`imp-*`) are now evicted before any chat sandbox when a user hits the live-container cap, so a preview render can't stop an active chat's workspace.

## [0.8.1] - 2026-07-13

### Fixed
- The share-import offer card now shows the Claude/ChatGPT brand mark instead of a generic icon.
- Share-link import is more robust: concurrent previews (e.g. two tabs) no longer share and wipe one sandbox session, a slow preview response can't overwrite a newer paste, and previews are rate-limited per user.
- The touch action sheet (long-press menu) now honors `prefers-reduced-motion`, shows a visible keyboard-focus state, and is chosen by pointer type rather than screen width — so a tablet gets the sheet and a narrow desktop window keeps the dropdown.

## [0.8.0] - 2026-07-11

### Added
- Import a public Claude or ChatGPT share link (**experimental**, off by default — set `CAPKA_SHARE_IMPORT=true` to enable): paste a `claude.ai/share/…` or `chatgpt.com/share/…` URL into the composer and Capka offers to import that conversation as a new chat and continue it with any configured model. The page is rendered in the sandbox (never the platform process), so it also needs sandbox egress (`SANDBOX_ALLOW_NETWORK=true`); when egress is off the attempt fails with a clear, non-blocking notice. Text/markdown only; attachments, images, and tool calls are not imported. The model is not run until the user's first reply.

### Changed
- On touch devices, long-pressing a chat row or a message now opens a full-width bottom action sheet (swipe-down / tap-outside to dismiss) instead of a cramped popover; desktop keeps the dropdown menu.

### Fixed
- The code viewer now keeps `Ctrl+A` / `Cmd+A` scoped to the open file instead of selecting text across the whole page.
- The composer no longer shows a phantom vertical scrollbar when empty or on a single line (sub-pixel rounding of the auto-grow height); it now scrolls only once the text actually exceeds the max height.

## [0.7.1] - 2026-07-11

### Changed
- Large attached images are downscaled in the sandbox (long edge 2048px) before being sent to the model, keeping them under provider per-image caps and cutting token cost; the full-resolution original stays in the workspace for `view_file` and metadata questions.

### Fixed
- The agent is no longer told it can "see" an attached photo whose bytes never reached the model (sandbox download failure, over the per-file/aggregate size cap) — it now announces only successfully delivered files as inline-readable and routes the rest to its tools, instead of answering as if it saw an image it didn't.
- Sending a message could, rarely, attach it to the wrong point in the conversation — appearing to edit or fork an earlier message — when a persisted send queue drained before the chat's history finished loading. Message parent linkage is now server-authoritative (anchored to the chat's active branch), and sends wait for history to load.
- A network drop mid-send (or mid-edit/regenerate) now surfaces a localized "no connection" message instead of the browser's raw `Failed to fetch`; failed edits/regenerations no longer fail silently.
- The composer no longer scrolls a long message back to the top on every keystroke, and no longer raises the on-screen keyboard when returning to the app on mobile (autofocus is desktop-only).
- Markdown tables in chat now scroll horizontally on narrow screens instead of crushing their columns to fit the message width.
- Chat list: more spacing between rows, and on touch devices the per-chat actions open via long-press (the always-visible ⋮ is hidden on touch, matching the message action menu).
- File tools (`read_file`, `list_files`, `search_files`, `str_replace`) no longer leak raw shell errors like `sed: can't read …: No such file or directory` into the chat; a missing/inaccessible path now reads as a plain "File not found: …". Actionable failures (e.g. over-quota) still pass through unchanged.
- Sandbox image rendering no longer exhausts the process budget under gVisor and fail with misleading `Cannot allocate memory` errors: the new `SANDBOX_PIDS_LIMIT` setting defaults to 256 (up from the previous fixed limit of 100), while `view_file` bounds ImageMagick's worker threads per render.

## [0.7.0] - 2026-07-10

### Changed
- The model picker no longer lays out and paints every catalog row on each keystroke: off-screen rows use `content-visibility: auto`, so filtering a large provider catalog (e.g. OpenRouter) stays smooth. Behaviour, keyboard navigation, and screen-reader access are unchanged.
- Chat messages, edits, and streaming answer blocks now settle in with a short opacity fade instead of the 500ms blur-rise, so the busiest surface reads calm and does no per-mount GPU blur work; the cinematic entrance stays on rare surfaces (onboarding, auth, empty states).
- Buttons and several chat transitions no longer animate every property (`transition-all` → explicit property lists), removing accidental layout/color animation and keeping motion on `transform`/`opacity`; the button press is a single `scale`, not scale + nudge.
- Tooltips now wait ~400ms before opening (was instant), so passing the cursor over controls no longer flashes stray tooltips; a series of tooltips still opens instantly after the first.
- `SECURITY.md` now documents that the workspace disk quota is enforced at command boundaries (a single command can transiently overshoot) and recommends a filesystem project quota / size-limited volume for multi-tenant or untrusted deployments, and clarifies the two-layer sandbox egress model (the `SANDBOX_ALLOW_NETWORK` kill-switch vs the `sandbox_network` org default).

### Fixed
- Workspace panel: the live file-listing refresh is now single-flighted and abortable, so a slow listing under the during-task safety-net poll can't stack overlapping requests or clobber the list with a stale/out-of-order response, and a late response can't fire after the panel closes.
- Accessibility: the "Copy redirect URI" button (Settings → Authentication) and the "Download all" button (workspace panel) now have accessible names, and copying the redirect URI is announced to screen readers via a polite live region.
- `sandbox-controller` now fails fast at boot on a malformed numeric env var (sizes, timeouts, limits) instead of silently degrading to `NaN` and disabling the guard it fed; the periodic maintenance jobs (idle sweep, GC/flush, over-quota scan) are single-flighted so a slow run under disk pressure can't overlap the next tick; and MCP stdio teardown now rejects in-flight RPCs and clears their timers immediately on session destroy instead of leaving them to the 60s timeout.
- PC folder sync now takes a server-side lease before touching files, so two browser tabs or project members can't run destructive sync operations against the same folder at once (the manifest CAS only guarded the ancestor row, not the files). The lease self-expires, so a client that dies mid-sync never locks the folder.
- `view_file` on HTML no longer fails with a "Trace/breakpoint trap" — the headless-Chromium screenshot now runs with `--headless=new --disable-dev-shm-usage`, so it stops exhausting the sandbox's tiny `/dev/shm` and crashing before the render lands.
- A finished turn whose task reached a terminal (failed/cancelled) status but whose assistant message was left stuck at "running" (a lost message write on the failure path) is now healed by the zombie reconciler, so it no longer revives a stuck spinner on every reload. Completed answers are never rewritten.
- A rare enqueue race no longer hands the client a task id that maps to no task (the stop button targeted nothing); the follow-up now always resolves to a real, cancellable turn.
- Automations: pausing (or deleting) an automation while its run is in flight is no longer undone — the scheduler's error-recovery re-arms a failed run only when the row is untouched, so a manual pause during a fire is respected instead of resurrected.
- Permissions: the "Ask" capability effect was labelled as behaving like "Allow" while the runtime actually blocks it (fail-safe, same as "Deny") until human-in-the-loop approval ships. Corrected the label and dimmed the "Ask" row to match.

### Security
- Content mutations (adding/toggling/deleting skills, enabling/disabling/uninstalling/upgrading plugins, revoking a connector's OAuth tokens) now require a write-capable, active account: a read-only `viewer` and a `pending`/`rejected` account are refused instead of relying on session presence alone. Chat branch switching still requires an active account (blocks pending).
- Unlinking Telegram now also revokes the Telegram login identity (the better-auth `account` mapping), not just the delivery link — so a previously-linked Telegram account can no longer sign in as the user after an unlink or a Telegram A→B switch.

## [0.6.7] - 2026-07-10

### Fixed
- Adding a skill, connector (MCP), or automation through chat works again: the `manage` tool's `args` object was serialized to the model with `additionalProperties: false`, silently forbidding every field (`repo`/`content`/`path`, `name`/`url`, …) so the agent could never fill it. A malformed `add` now also echoes the collection's expected shape instead of a generic error.
- The chat minimap (right-edge jump list of your own messages) is now keyboard-operable — reachable by Tab, opens on Enter, closes on Escape; it was previously mouse-hover only, leaving the jump list unreachable without a pointer.
- Reduced-motion now also collapses animation delays, so delayed and staggered entrances no longer sit invisible before appearing; added a reduced-transparency / high-contrast fallback that drops backdrop blur on overlays and chrome.
- Confirmation and approval cards play their success haptic only after the server accepts the action (error haptic on failure) instead of optimistically on press.

### Security
- Installing a skills repo through chat now pins to the exact commit shown in the approval preview instead of re-resolving the branch tip when the user approves, closing a window where upstream could swap the installed skills between preview and install.

## [0.6.6] - 2026-07-09

### Security
- Outbound fetches to user-supplied URLs (MCP servers, OAuth discovery, marketplace, custom provider base URLs, and provider model listing) now pin the TCP connection to the pre-validated IP, closing the DNS-rebinding window to a private/metadata address. First-party fixed hosts are unaffected.
- Cleared the `js-yaml` moderate advisory pulled in transitively through `gray-matter` (`npm audit`).

### Changed
- The `sandbox-controller` image now installs strictly from its lockfile (`npm ci`) and fails the build on a broken/absent lockfile instead of silently falling back to `npm install`.

### Fixed
- `GET /api/automations` resolves each automation's last-run chat in one batched query instead of one round-trip per automation.
- Workspace panel accessibility: file download buttons now have an accessible name, the closed panel is no longer reachable by keyboard (`inert`), and the usage-limit bar animates only its width.

## [0.6.5] - 2026-07-09

### Added
- More brand icons selectable for a custom OpenAI-compatible connection: model creators Upstage (Solar), Nous Research, Liquid AI; inference endpoints Hugging Face, Cloudflare Workers AI, GitHub Models.

### Changed
- Settings → Connections is now a compact list: each connection is a single row that expands to its settings, and connections can be dragged (or moved with the keyboard) to set their order. That order also drives the chat model picker, and the top enabled connection is the default a new chat opens with (marked "default").
- The xAI provider icon is now the corporate xAI mark instead of the Grok product glyph.

## [0.6.4] - 2026-07-09

### Added
- Brand icons now cover more model creators (Tencent/Hunyuan, ByteDance/Doubao, Baidu/Ernie, Databricks/DBRX, InternLM, Baichuan, Stepfun, LongCat, 01.AI/Yi) and inference providers (Groq, Cerebras, Together, Fireworks, SambaNova, DeepInfra, Novita, Hyperbolic, SiliconFlow, Nebius, Baseten, vLLM, LM Studio, Azure); the extra provider glyphs are selectable when naming a custom OpenAI-compatible connection.

### Fixed
- The activity log now shows human names instead of raw internal ids: a changed setting shows its localized title (e.g. "Interface language", not `user.locale`), and enabling/disabling/removing a connector, skill, or plugin shows the item's name instead of its opaque id.

## [0.6.3] - 2026-07-09

### Changed
- Telegram replies no longer append the model's reasoning as a collapsed
  "💭 Reasoned for Xs" block; the final message is the answer plus the tool-log
  footer only. Live thinking still shows in the streamed draft.

### Fixed
- The sandbox prompt now reflects the session's actual egress: when network is enabled (`SANDBOX_ALLOW_NETWORK=true` + `sandbox_network=bridge` or a project override), the model is told it has internet instead of the hardcoded "no network by default", so it stops refusing to install packages or make requests.

## [0.6.2] - 2026-07-09

### Fixed
- Model-catalog resync now refreshes LiteLLM-sourced rows instead of freezing them at first insert, so a model's later-known input modalities (e.g. audio for Gemini) reach the picker — fixing a spurious "model can't read this file" for audio on LiteLLM/OpenAI-compatible gateways. Resync the catalog (Settings → Connections) after upgrading.

## [0.6.1] - 2026-07-09

### Changed
- The "this model can't read that file" heads-up now appears quietly in the composer while a file is attached, instead of under the reply after sending — so the user can switch models before spending a turn.

### Fixed
- Audio attachments in a container the model transport can't serialize (opus/ogg/m4a/flac) are now transcoded to mp3 in the sandbox before sending, so voice notes reach audio-capable models over LiteLLM/OpenAI-compatible and OpenRouter — previously only wav/mp3 got through and anything else was dropped with a "can't read" notice.

## [0.6.0] - 2026-07-08

### Added
- New `view_file` tool lets the agent SEE a workspace file — image, PDF, office document (docx/pptx/xlsx…), or HTML — rendered to page images, so it can check its own generated documents for broken layout before handing them over. Offered only to vision models; on chat-completions transports (OpenAI Chat, LiteLLM/openai-compatible) the pages are delivered as a follow-up message since those can't carry an image in a tool result.
- The agent can run long sandbox work in the background: `execute_bash` with `background:true` starts a detached job and returns at once (surviving the 300s exec cap and past the reply), and a new `check_job` tool reports its status, exit code, and log tail. The job keeps running as long as the sandbox lives.

### Fixed
- A sandbox command running longer than 150s is no longer cut off by the platform's HTTP client before the controller's own 300s exec cap; the client now waits out the full exec window.

## [0.5.0] - 2026-07-08

### Added
- Connector tools are now loaded on demand once they would tax the model's context window: the agent sees a compact per-connector index plus a `find_tool` search instead of every connector's full schema each turn, cutting token cost and improving tool selection for chats with large MCP connectors (e.g. Firecrawl). Provider-agnostic (works on any model). Tune the trigger with `MCP_DEFER_TOKEN_PCT` (default 10, percent of the effective context window).

### Fixed
- `manage` no longer shows a non-admin the confirm card for attaching a server folder (or an admin-only connector): the authorization pre-flight now runs before any approval card, so a change the user can't apply isn't offered as a dead end.
- The `manage` activity timeline no longer labels a read as "Updated settings" (a false alarm when the agent only looked); a collection read now names its domain (e.g. "Reviewed connectors").

## [0.4.1] - 2026-07-07

### Added
- Optional `ACME_EMAIL` enables Caddy's ZeroSSL fallback issuer on `DOMAIN` deploys (helps when free `sslip.io` hostnames hit the shared Let's Encrypt rate limit). Applied by `up.sh`; on plain `docker compose`/Coolify, write the `email` line to `data/caddy/conf.d/email.caddy` yourself.
- `DOCKER_SOCKET` sets the socket-proxy's host socket path; required for rootless Docker (see SECURITY.md). Defaults to `/var/run/docker.sock`.
- `install.sh` opens ports 80/443 in an active `ufw`/`firewalld` on the turnkey-HTTPS path so the certificate can issue. Set `CAPKA_NO_FIREWALL=1` to manage the firewall yourself.

### Changed
- The sandbox image downloads in the background on controller boot, so the stack reports healthy in seconds instead of after a multi-GB pull; a failed pull retries with backoff, and the first sandbox call returns a clear "still preparing" message if it lands mid-download.
- `install.sh` preflights RAM/disk, requires `docker compose` v2.24+, and adapts to servers already running other sites (stays off busy 80/443/3000, binds loopback, prints how to front Capka); a `DOMAIN=` install where 80/443 are already taken now falls back to reverse-proxy mode instead of a crash-looping Caddy. It no longer reinstalls Docker over a daemon running containers.
- Default install command no longer needs `DOMAIN=` — the installer offers a free `sslip.io` HTTPS address, or type `http` for plain HTTP.
- `up.sh` waits until the app is healthy before printing the address, verifies Caddy obtained the certificate on `DOMAIN` deploys (printing firewall/DNS causes if not), and flags a running-but-unhealthy service instead of calling it "still starting". Re-run it any time to reprint the address.

### Fixed
- First install no longer fails while the sandbox image is still downloading (platform starts independently of the controller).
- Reinstalling or rotating `POSTGRES_PASSWORD` over an existing database volume no longer crash-loops on an auth error: a `db-init` one-shot verifies the role password over TCP and re-syncs it on drift, on all deploy paths (plain `docker compose up`, Coolify, and the scripts).
- A failed certificate or platform boot no longer leaves the host unreachable — Caddy starts independently and keeps a `127.0.0.1` rescue publish.
- `.env` files saved with Windows (CRLF) line endings are normalized on start.

## [0.4.0] - 2026-07-05

### Added
- New Settings → Activity page: a readable, per-day audit trail of admin and configuration changes, showing who did each action, filterable by category (People/Extensions/Settings/Security) with load-more paging. Replaces the raw action-code list that was buried under Permissions.
- Settings → Users now shows pending sign-ups with inline approve/reject (moved off Authentication), 30-day shared-key spend per person, join date, role filter, search, and account removal.

### Changed
- Settings → Usage: token/cache/blended-rate metrics moved into a collapsible "Technical details" block; the by-member list is now searchable and clicking a person filters recent activity to them.

### Fixed
- Audit trail now records skill enable/disable/remove, automation enable/disable/remove, and instance billing changes, and renders every action (including `auth_config.update`, `user.role_change`, master-key access) as a localized sentence naming the actor — several of these previously went unlogged or showed as raw keys.
- Settings nav no longer flickers on every navigation — admin-only items briefly vanished and reappeared because the route crossfade remounts the pane, re-fetching admin/billing status each time; both are now cached across remounts.
- README and `docs/DEVELOPMENT.md` no longer link to a `DEPLOY.md` that isn't in the repo (it was untracked as maintainer-private); a public `docs/DEPLOY.md` deployment guide now backs those links.

## [0.3.0] - 2026-07-05

### Added
- Telegram bot now auto-creates an account on first contact, so a new user can just message the bot instead of signing in on the web first. Governed by the existing registration mode (`open` → active, `approval` → pending, `closed` → refused) and disabled until first-run setup completes; only from private chats. For a publicly-reachable bot, prefer `approval` mode — under `open` anyone who finds the bot gets an account that can spend the shared key.
- Attach folders to a chat's sandbox, off by default via two new org settings in Settings → Security. `host_folder_access` (admin-only) bind-mounts a server folder at `/folders/<name>`; restrict mountable paths with `SANDBOX_MOUNT_ALLOW` (`:`-separated roots). `pc_folder_access` (`off`/`admins`/`everyone`) lets users sync a folder from their own computer (live sync needs Chrome/Edge; other browsers get a one-shot import + zip). See SECURITY.md.

### Fixed
- Desktop: buttons (e.g. the sidebar toggle) no longer intermittently swallow
  clicks while a reply is streaming — streamed markdown updates were triggering
  a full-page view transition ~4×/s, whose overlay also made the whole page
  appear to re-render. Route-navigation crossfades are unaffected.
- The chat scrollbar no longer flickers in and out while a reply streams into
  a fresh (not-yet-scrollable) chat.
- Desktop: dragging the scrollbar while a reply is streaming no longer snaps
  the view back on every delta (scrolling felt locked until the mouse wheel
  was used once).
- Adding a provider no longer fails with "The provider rejected the request
  (HTTP 200)" for OpenAI-compatible gateways that always stream (e.g. omniroute):
  the connection test now probes over the streaming transport that real turns
  use, and times out after 30s instead of hanging.
- Long streaming replies no longer freeze the chat on phones (dead taps,
  stuttering scroll): incoming deltas are now coalesced client-side into ~4
  renders/s, halving main-thread load at the tail of a long answer.
- Message actions (edit/fork/regenerate/version arrows) stay visible but
  disabled while a reply is streaming, instead of vanishing and reappearing.

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
