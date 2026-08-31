# Changelog

All notable changes to Capka are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Notes now store their body in immutable revisions (`vault_note_versions`); the backfill runs at boot and needs no operator action.
- New admin-only `POST /api/admin/vault/reindex` (body `{"spaceId": "..."}`) rebuilds one space's memory search index.
- The memory search index is now written with every fact and topic it projects; the boot migration back-fills every existing space.
- Memory search is now full-text plus trigram. The boot migration runs `CREATE EXTENSION pg_trgm`; the database role must be allowed to create extensions or the migration fails.
- New `vault_nodes` / `vault_edges` tables; applied automatically at boot, no operator action.
- Every vault claim, note and document now has a `vault_nodes` row; the backfill runs in the boot migration.
- Vault claims carry a server-assigned trust class and a generated `prompt_access` channel; existing claims are mapped from `review_status` by the boot migration.
- Vault data foundation (content-addressed blob store; sources/versions/fragments/citations schema) — groundwork for project knowledge.
- Facts can now be deleted from the memory page, including sensitive ones the assistant is not allowed to read.
- The memory page now says how a fact gets saved — by telling the assistant in a chat — and why the set-aside list is waiting.
- A "forget everything" control on the memory page removes every recorded fact and every set-aside candidate across the user's own memory and all their projects; the audit trail of the reset is kept.
- Facts the assistant recorded but could not activate can now be kept or discarded on the memory page, with the wording editable first.

### Changed

- Claim trust classes are now minted by one module (`src/lib/vault/grounding.ts`); no other code path can state a `source_class`.
- Memory search now matches by full text and trigram similarity instead of substring, so a misspelling or a different word order still finds the fact.
- The "N saved items are marked sensitive" line `memory_search` appends now counts sensitive facts still awaiting confirmation, not only kept ones.
- A proposed fact that duplicates one `memory_search` can already find — including a fact still awaiting confirmation — is answered "already known" and writes nothing, so the review queue no longer fills with duplicates.
- Agent memory is now a structured vault: facts with provenance, quarantine for web/tool-derived facts, full audit trail; existing memory documents migrate automatically at boot. The old memory editor is read-only until the new memory page ships.
- The memory page now shows topics, each fact's source conversation and what it replaced, and the facts set aside awaiting the user's confirmation (migration 0057).
- The memory page's topic rail is replaced by one searchable list of every approved fact, newest first (server-side search on `GET /api/memory?q=`, 200 rows per scope). No database change: topic rows stay as they are and the prompt manifest still lists topics.
- Settings search keywords moved into the message catalogs (`settings.search.*`), so each locale ships its own synonym list instead of one hardcoded bilingual string.
- Files carried into a project when a chat is moved land in an English subdir (`From chat "…"`), which stays stable across an interface-language change so a retry replaces rather than duplicates the copy.
- Web citations redesigned: [N] markers render as raised number pills with a hover card (title, domain, date), and the "Sources" footer is a grid of source tiles with domain monograms, one tile per URL, collapsing beyond six.
- The memory page shows a sensitive fact's text to its owner, blurred behind a per-row reveal control, instead of withholding it; the manifest and `memory_search` still withhold it from the model.
- A memory row's source line links to the conversation it came from, and a conflicting one names the fact it would replace.
- Conflicts raised by the assistant's own `memory_update` now name the fact they contest, like extraction-raised ones already did.
- The assistant can no longer save, correct or delete a memory fact on its own: every fact it records waits on the memory page until the user keeps it, and `memory_forget` refuses outright.
- Memory documents from the old system now migrate into the review queue instead of straight into memory, so the user keeps their carried-over facts once.
- A memory step in the chat timeline is labelled by what was attempted ("Memory proposal") rather than by a success that may not have happened.
- Facts no longer merge automatically: two facts about the same thing accumulate as duplicates and the user resolves them on the memory page (`vault_claims.slot_key` is a display hint; `uniq_vclaims_active_slot` dropped in migration 0058).

### Fixed

- Keeping a correction on the memory page now actually replaces the fact it names, instead of leaving both facts live and asserting each to the assistant; if that fact was already replaced by something else in the meantime, the correction is saved beside it and nothing is superseded.
- Keeping a correction whose wording the memory already holds no longer records that wording a second time: the fact it contests is removed and the existing one is kept.
- Memory topics are identified by a stable key instead of their displayed title, so renaming one no longer forks it into two the assistant counts twice.
- Deleting a project now closes its memory for good: a post-turn fact extraction still running when the project is deleted no longer writes into the deleted project's memory (`spaces.retired_at`, migration 0056).
- Memory tool calls read as memory in the chat timeline instead of "Searched the web" with a globe — `memory_search` was matching the web-search name heuristic.
- A forked or cloned chat is named in the interface language — the "(copy)" suffix was hardcoded Ukrainian for everyone.
- Inline citation pills actually render in the web chat — the markdown sanitizer strips the attribute the previous CSS styling targeted, so markers showed as plain blue numbers and a `[1, 9]` group read as "19".
- A reply's [N] markers no longer resolve against a different message's sources (markdown processor cache collision on anonymous plugins).
- A chat whose first turn goes through an approval or "Ask" prompt is now auto-titled instead of keeping the placeholder name for good.
- The step timeline no longer opens an empty thought row for a reasoning part carrying only a line break, which some models emit between tool calls.
- A fact stated while answering an assistant question is now attributed to the user instead of waiting for confirmation.
- Keeping a set-aside fact whose slot a sensitive fact holds now works instead of failing with "try again" on every attempt.
- A sensitive fact quoted in a conflict line, or opened for editing, is blurred like every other sensitive statement on the memory page.
- The memory page no longer quotes an unverified claim as the fact a conflict would replace.
- The memory page's search no longer lets a slower, older request overwrite a faster, newer one's results, and a stale request failing after a newer one succeeded no longer blanks the whole page with a load-error panel.

### Security

- A memory fact that looks like a credential is stored sensitive whatever wrote it, so it is never re-injected into a prompt and never returned by memory search.
- The boot-time memory migration logs only the error message on failure, so a failing statement's bound parameters no longer reach the log.
- Memory audit events (`audit_events`) no longer carry a fact's slot key or a forget reason, so no memory text survives a project delete; `memory_forget` accordingly no longer takes a `reason`.
- An unmigrated memory document is no longer sent to the model: the prompt's raw legacy fallback is removed, so an old document holding a credential cannot be disclosed on every turn while its migration fails.
- Lexical overlap with the user's own message no longer authorizes a memory write, so a fetched web page cannot rewrite or erase a fact the user merely mentioned.
- A credential straddling the 500/120-character truncation boundary is now flagged: the screen classifies the text as given as well as the text as stored.
- The boot migration's audit event no longer carries a document hash or character count, which together allowed a deleted document's text to be recovered by dictionary attack.
- The credential screen is now shape-based only (a long opaque run) and is documented as an advisory flag rather than a boundary; its English-only word list is removed, since it flagged `password: …` and missed the same sentence in every other language.
- A memory confirmation can no longer land on a fact that was superseded while the user was deciding; `vault_claims.approved_at`/`approved_by_user_id` record who approved each fact (migration 0058).

## [0.37.0] - 2026-08-29

### Added

- The Telegram marker next to a message's timestamp now explains itself on hover ("Sent via Telegram"), like the other icon-only controls.

### Changed

- Telegram citations now ride native Bot API footnotes: [N] markers render as superscript references with a footnote section, instead of a quoted "Sources:" list (kept as the fallback when a marker only appears inside code).

### Fixed

- Web citation chips render as styled pills again; the transcript's link renderer dropped their attributes, so a `[1, 9]` group read as a bare blue "19".
- Citation chips no longer stay inert until a page reload on a freshly finished message that cites a previous turn's sources.
- The live "Thinking…" row now continues the activity rail as its next step, instead of floating a message-gap below the last one.

## [0.36.0] - 2026-08-28

### Added

- The "Ask" permission effect is now a real approval gate: a connector or skill set to "Ask" stays available to the agent, but every call suspends the turn with an Allow/Don't-allow card (web and Telegram) showing what would run and with what arguments; the decision resumes the turn. "Ask" previously behaved as a block.
- Web search through MCP connectors now yields citations: a search-shaped tool result (Tavily, Brave, Exa, Firecrawl, SearXNG, …) is recognized by shape, numbered, and rendered as a source list, and the reply's inline [N] references become clickable chips with a "Sources" footer. A number the model invents stays plain text, never a link.
- Telegram replies that cite search results end with a "Sources:" block resolving the [N] markers; six or more sources collapse behind an expandable quote.
- Streaming Telegram replies carry a native Stop button (Bot API 10.3): it cancels the turn the same way the web stop does, and the partial answer is kept as a real message instead of vanishing with the draft.
- Icon-only buttons across the web UI (composer, message actions, file panel, model picker, sidebar, settings) show a styled localized tooltip on hover/focus; keyboard shortcuts (e.g. ⌘B) render inside it. Desktop-only — touch is unaffected.

### Changed

- grammy bumped to 1.46.0 (Bot API 10.3).
- Citation numbers are now unique across a whole conversation branch (not per turn), and a reply citing a previous turn's search source still renders a working chip and footer entry.
- Search-result normalization keeps the publication date when the connector provides one (shown in the source panel and to the model).

### Fixed

- A skill set to "Deny" is now refused when the agent calls it by name; previously the policy only hid it from the skills list in the prompt.
- Telegram approval buttons now pin the exact suspended tool call via a digest (the raw id rarely fits Telegram's 64-byte callback limit); a stale unpinned card could previously approve a different, later call sight unseen.
- The Telegram Stop button now cancels exactly the draft it sits under; it could previously cancel a queued follow-up or, after `/new`, a turn in a different chat.
- Large JSON search responses (past the 30k output clamp) no longer lose their citations — sources are extracted before the result is bounded.
- A connector can no longer forge extra `[N] Title — URL` source lines through newlines embedded in titles or snippets.
- A stopped (partial) Telegram reply keeps its "Sources:" block, so its [N] markers stay resolvable.

## [0.35.0] - 2026-08-28

> **⚠ Breaking — a deploy reachable beyond loopback now refuses the first-run admin claim unless `SETUP_TOKEN` is set.** `scripts/up.sh` generates one there and prints a `#token=…` setup link, so the turnkey path is unchanged; a hand-rolled `docker compose up` on a public address must set `SETUP_TOKEN` and restart before finishing setup.

### Added

- The per-user shared folder (`/shared`) is browsable from the chat file panel — list, preview, download, delete. It was previously reachable only by the agent, which its own prompt invites to store reusable files there.

### Changed

- A tool result that carries one JSON value as text now goes through the same shape-driven rendering as typed output (record lists, tables, field grids), descending through metadata wrappers like `{success, data: {…}}`; JSON that matches no shape at least renders re-indented in monospace instead of as a single line.
- `SANDBOX_PIDS_LIMIT` now defaults to 1024 (was 256): under gVisor the budget is a high-water mark that is never reclaimed, so a working session exhausted it and the sandbox was killed outright. Deployments that pinned 256 should raise it.
- Provider model-listing failures no longer put the upstream response body in the error message.

### Fixed

- A sandbox command that exits non-zero now says so in the step panel ("Command exited with code N") — it previously rendered indistinguishably from a successful one.
- A sandbox killed under a running command no longer returns the container runtime's internals as that command's output: the session is invalidated and rebuilt, and the agent is told the sandbox restarted and that `/workspace` survived.
- Deleting a chat now tears down the sandbox session and folder attachments it owned; `attached_folders` rows carry a plain session key with no foreign key, so nothing ever reclaimed them. A chat inside a project shares the project's workspace and is left untouched.
- The provider model-listing cache is bounded at 100 entries: expired entries were only skipped on read, never evicted, so listing distinct `baseUrl` values grew platform memory for the life of the process.

### Security

- The first-run admin claim is fail-closed on a networked deploy (see the breaking note above). Exposure is decided from `PLATFORM_BIND` and `PUBLIC_URL`, never from a request header — a `Host: localhost` header cannot unlock it.

## [0.34.0] - 2026-08-23

### Changed

- A generic (MCP/plugin) tool step now shows its arguments as a readable label–value list instead of a highlighted JSON block; the verbatim JSON moved behind a folded "Technical details" link.
- Copy/download controls over code blocks and tables lost the floating white card look — they sit quietly on the content and firm up on hover.
- A tool result that is a list of records — typed `structuredContent` per the MCP spec, or repeated "Key: value" text blocks — now renders as a readable list with clickable links; markdown-shaped results (scraped pages) render as markdown. Anything else falls back to plain text unchanged.
- Tool results also render the MCP envelope's other block types: images inline, `resource_link`/`resource` as chips, a single typed object as a label–value grid, and homogeneous short record lists as a table.

### Fixed

- A platform that starts before its database no longer runs on a frozen schema until the next restart: a boot migration that fails is retried in the background until it lands.
- Hovering an expandable tool step no longer paints the highlight over the step's icon and timeline rail.
- Capka's own scratch files under `.capka/` (capture logs, background-job dirs, rendered previews) no longer appear as a turn's artifacts: a command whose output overran the inline cap surfaced its recovery log as the reply's only file tile. They remain readable and downloadable by path.

## [0.33.0] - 2026-08-23

> **⚠ Breaking — the first controller start after upgrading recreates every sandbox container.** Workspaces (users' files) survive the rebuild; a background job running inside a sandbox does not, so let long-running jobs finish before upgrading. The new HOME tmpfs is charged against `SANDBOX_MEMORY_MB`, leaving 64 MB less for processes unless you raise it.

> **⚠ Breaking — the sandbox image no longer renders LaTeX or CJK text.** TeX Live and the JRE are gone, so `pdflatex`/`xelatex` and `.tex` input fail; `fonts-noto-cjk` is replaced by `fonts-noto-core`, so Chinese, Japanese and Korean glyphs render as blank boxes.

### Added

- Pinch-to-zoom in the image preview, on touchscreens and on the macOS Safari trackpad.
- Swiping sideways on a touchscreen pages between the files in an image preview, the way the arrow keys and the header arrows already do.
- A file a tool step created, edited or read opens from the step's chip in the reply, which now carries a thumbnail of it.
- Sandbox image: ghostscript, aria2, 7zip, Ukrainian OCR (`tesseract-ocr-ukr`), ocrmypdf and typst, plus the Python packages polars, duckdb, fastparquet, python-calamine, weasyprint, msoffcrypto-tool and extract-msg.
- `SANDBOX_HOME_MB` sets the size of the sandbox's writable HOME tmpfs (default 64); like the other tmpfs mounts it is charged against `SANDBOX_MEMORY_MB`.
- `npm run sandbox:smoke [image]` runs the sandbox image's capability suite — document conversion, HTML/Markdown to PDF, diagrams, Ukrainian OCR, parquet — in a container built by the real container spec rather than a hand-written `docker run`. The release workflow runs it on every sandbox image it builds and refuses to publish if it fails.
- The sandbox image carries `/opt/capka/TOOLS.md`, generated at build time with the versions that actually resolved, and the agent is told to read it before installing anything.

### Changed

- A tool step now shows what the model sent — the command, the code, the file's new contents, or a before/after for an edit — above its result, with both labelled.
- The live status names a wait ("Setting up the workspace…") only once it has lasted about a second and a half, instead of flashing it for every short one.
- The sandbox image no longer ships TeX Live or a JRE (~500 MB): pandoc produces PDFs through weasyprint, and camelot/pdfplumber cover what tabula-py did. Workflows that invoke `pdflatex`/`xelatex` or feed a `.tex` file no longer work.
- Building the sandbox image now fails if a tool or Python module it is supposed to contain is missing, instead of shipping and failing at runtime.
- The controller refuses to boot when its deployment knobs and `DEPLOYMENT_KNOBS` disagree: an unforwarded knob ran containers on defaults while marking them stale, which rebuilt every sandbox on every boot.
- The sandbox image renders mermaid with a small built-in renderer instead of `@mermaid-js/mermaid-cli` (−460 MB, pinned via the `MERMAID_VERSION` build arg): `mmdc -i x.mmd -o x.svg|png|pdf` and the `-t/-b/-w/-H/-s` flags still work, while flags it does not implement are refused rather than silently ignored.
- The sandbox image ships `fonts-noto-core` instead of `fonts-noto-cjk`: better Latin and Cyrillic defaults, at the cost of CJK text rendering as blank boxes.

### Fixed

- Document conversion in the sandbox works again: the agent's `$HOME` is now a writable tmpfs, which the read-only rootfs had left immutable — `soffice --convert-to pdf` and the `html2pdf` shim were producing no file at all.
- Mermaid rendering (`mmdc`) and a plain `chromium` call work again: the image's `chromium` entry point passes `--no-sandbox`, without which Chrome cannot start under the container's dropped capabilities.
- `.parquet` files can be read in the sandbox; the image shipped pandas with no parquet engine installed.
- `markitdown` can convert office formats again: the image installed it without its optional extras, so every `.docx`/`.xlsx`/`.pptx`/`.pdf` conversion failed with a missing-dependency error.
- Tool output too long to show now states how much of it is displayed and offers the rest, instead of ending in an ellipsis that looked like the end of the output.
- A failed tool step now opens itself instead of staying collapsed, and its error is shown monospaced, scrollable and copyable rather than as a single unwrapped line.
- A tool still running when a turn hits its time limit or loses its worker is now recorded before it starts, so a restarted or continued turn is told the call may have taken effect instead of being told nothing ran. Migration applies at boot; no action required.
- "Continue" after a part-way failure now carries the previous reply's executed tool calls into the new turn, so continuing no longer repeats writes that turn had already made.
- The "Continue" button no longer stays disabled for good when the send behind it does not go through.
- A crashed turn whose tools already ran is now reported as partial rather than a total loss: the zombie reconciler reads the executed-call ledger, not only the reply's saved parts, so the user is offered "Continue" instead of a retry that repeats those writes.
- Image preview zoom now follows how far the wheel or trackpad moved rather than how many events the device sent, so a light two-finger swipe no longer jumps straight to maximum zoom.
- The image preview no longer lets a picture be dragged out of the window, and its zoom buttons no longer reset the zoom when clicked twice quickly.
- Background calls (a chat title, a memory doc, a summary) no longer pay a rejected request each for a model that cannot reason: the refusal is remembered once and shared with the main turn.
- The mid-turn context brake now re-engages on the first step after a turn restarts, instead of sending one unbraked request — on providers without a server-side context edit.
- The prompt-size estimate that arms that brake no longer under-counts tool traffic by up to a third: it divided bytes by 4, a prose ratio, for content that is almost entirely JSON.
- `message_effects.input` no longer stores a tool call's whole payload; rows are bounded to roughly what the recovery note can read. Existing rows are left as they are.
- A recovery note now names the file or record a large tool call targeted, instead of showing a prefix of the payload that pushed the identifying argument off the line.

### Removed

- `pdfkit` is gone from the sandbox image: it wrapped `wkhtmltopdf`, which the image deliberately does not install, so every call failed.

## [0.32.0] - 2026-08-23

### Changed

- The live status row on a running turn now names which wait it is (in queue, connecting to the model, setting up the workspace) instead of always saying "Thinking…", and its clock starts when the message is sent rather than when the model call begins.
- Durations in chat read in the interface language (`8 с`, `1 хв 32 с`) instead of latin `8s` and the ambiguous `1:32`.
- `MAX_STREAM_RECOVERIES`, `JOBS_KEEP_DIRS`, `OUTPUT_KEEP_FILES`, `VIEW_KEEP_DIRS` and `MAX_MCP_MEDIA_BYTES` now accept `0` as the policy it reads as — no re-streaming, keep nothing, always spill connector media to a file — where zero was previously replaced by the default.

### Fixed

- A turn whose model emits no reasoning no longer looks dead between a finished tool call and the next step: the status row returns for that gap instead of leaving the Stop button as the only sign of life.
- A negative, fractional or mistyped value for thirteen numeric knobs now falls back to the built-in default instead of being used as written: `TASK_TIMEOUT_MINUTES`, `STREAM_IDLE_SECONDS`, `MAX_STREAM_RECOVERIES`, `MAX_AGENT_STEPS`, `PG_POOL_MAX`, `WORKER_MAX_CONCURRENCY`, `JOBS_KEEP_DIRS`, `JOB_LOG_CAP_MB`, `OUTPUT_KEEP_FILES`, `OUTPUT_FILE_CAP_MB`, `VIEW_KEEP_DIRS`, `MAX_MCP_MEDIA_BYTES` and `MAX_MCP_TOOL_DESC_CHARS`. `TASK_TIMEOUT_MINUTES=-1` aborted every turn within milliseconds, and `WORKER_MAX_CONCURRENCY=10g` ran ten tasks at once.
- Boot config warnings name the value that will actually run for each knob rather than always claiming a fallback — `PG_POOL_MAX=10g` is reported as falling back to 20, and a value the reader genuinely honours is not reported at all.
- `MCP_DEFER_TOKEN_PCT` and `MCP_DEFER_TOKEN_MAX` no longer warn at boot for `0` or a fractional value; both are honoured, and only the warning said otherwise.
- `FORCE_TEXT_AFTER_STEPS` is validated against the ceiling `MAX_AGENT_STEPS` sets rather than as a standalone integer, so a value above that ceiling is reported instead of silently clamped.
- A model that rejects reasoning outright is remembered, so it stops paying a rejected provider request and a full stream restart on every turn.
- Reasoning clearing on Anthropic no longer switches on at 12% of a large context window: it has its own uncapped half-the-window threshold instead of sharing the tool-clearing trigger, which is capped at 120k and measured 15-58% more expensive than carrying reasoning on deep tool loops.

## [0.31.0] - 2026-08-22

### Added

- `WRAP_UP_AFTER_FRACTION` (default `0.8`): a turn stops calling tools once it has spent this much of its run-time budget and answers with what it has, instead of being cut off mid-tool when the deadline fires.
- `MAX_TURN_TOOL_OUTPUT_CHARS` (default `400000`) caps the total tool output one turn may produce. Past it the turn stops calling tools and answers with what it has, bounding both context growth and spend regardless of what the provider reports.

### Changed

- Workspace archives download as `.zip` instead of `.tar.gz`, named after the project or chat and dated (`Quarterly report — 2026-08-22.zip`) instead of a fixed `workspace.tar.gz`. Self-hosters who build images locally must rebuild `sandbox-controller`, which now installs `zip`.
- `TASK_TIMEOUT_MINUTES` now defaults to 20 minutes, up from 10 — the old ceiling was shorter than `MAX_AGENT_STEPS` tool calls at the controller's 30-second exec timeout, so heavy sandbox work timed out with step budget to spare. Both it and `WRAP_UP_AFTER_FRACTION` now reach the platform container in `docker-compose.yml`.

### Fixed

- Download filenames taken from a project name or chat title are now valid on every OS: `Q4: plan` was unsaveable on Windows, and a title ending in a dot saved under a different name than the one served.
- A turn that times out or loses its worker after producing work now offers "Continue" instead of advising a retry, matching what a stalled turn already did — retrying re-runs every tool and rewrites what the turn already wrote. Covers a turn reaped after a crash or restart, whose verdict comes from the zombie reconciler rather than the worker.
- A tool call that ran and then threw now counts as work worth keeping, so a turn cut short right after one is no longer reported as a total loss — a script can write three files before it fails.
- A malformed `WRAP_UP_AFTER_FRACTION` is reported at boot instead of being clamped in silence.
- A deep conversation on Anthropic now also sheds old thinking blocks server-side, not just old tool results. Only past the same depth threshold: the strategy has no trigger of its own, so applying it to every request would cost more cache than it saves.
- Nineteen tuning knobs the platform reads at runtime are now settable under Compose and documented in `.env.example` — `MAX_TOOL_OUTPUT_CHARS`, `MAX_TOOL_OUTPUT_LINES`, `STREAM_IDLE_SECONDS`, `MAX_STREAM_RECOVERIES`, `WORKER_MAX_CONCURRENCY`, `PG_POOL_MAX`, five workspace-retention caps, five MCP caps, `CAPKA_STREAM_USAGE`, `CAPKA_SHARE_IMPORT` and `OTEL_SERVICE_NAME`. None of them could be set before.
- `BETTER_AUTH_URL` reaches the platform container again; the documented `PUBLIC_URL` fallback had become a silent no-op under Compose.
- Twelve newly reachable numeric knobs are validated at boot, and for the three tool-output caps a negative or mistyped value now falls back to the built-in default instead of being used as written — `MAX_TURN_TOOL_OUTPUT_CHARS=-1` stopped every turn from using tools at all.
- `ALLOW_DB_MASTER_KEY` now reaches the platform container, so the documented escape hatch for accepting a DB-stored key in production actually works.
- The mid-turn tool-traffic trim now keeps the three most recent tool exchanges it promises, instead of roughly one and a half.
- The mid-turn trim now also engages on endpoints that report no token usage, using a local estimate of the prompt rather than staying disengaged for the whole turn.
- A turn no longer finishes as successful when its reply row was deleted while the turn sat queued; it stands down instead.
- The per-run log line now also carries the prompt size, message count, recovery count and total tool output, so an opaque provider error is diagnosable from the logs and not only from the stored message.
- Admins keep seeing the raw failure detail for a turn that ran on their own key after the chat history is reloaded.
- A tool call the model malformed no longer appears in a restarted turn's recovery note as work that already ran, which could make the model skip it entirely.
- A turn interrupted right after a malformed tool call no longer tells the user that work was kept and can be continued, when nothing had run.
- A tool call that already ran is now recorded in its own `message_effects` table, so a turn that restarts or resumes no longer repeats a non-idempotent write whose record an emergency context trim had erased from the reply row. Migration applies at boot; no action required.
- `MAX_AGENT_STEPS` now reaches the platform container in `docker-compose.yml` and is documented in `.env.example`; it has never been settable in a Compose deployment.
- The mid-turn tool-traffic cut no longer sheds one message more than intended on a turn where a `view_file` image bridge is injected.
- A workspace file the agent merely mentioned no longer shows up in the log as a `sandbox download failed` error; a missing file is logged as a warning, and every sandbox download failure now names the session, the path and the status. The same rule now covers file listings, archives and uploads: a 4xx is logged as a warning, a 5xx as an error, and each line carries the session and status.

### Security

- The workspace access token no longer reaches the platform log. Any failed file listing or delete recorded the raw controller URL, whose query string carries the HMAC that authorizes access to that workspace.

## [0.30.0] - 2026-08-22

### Added

- `FORCE_TEXT_AFTER_STEPS` pins the step at which a long tool loop is told to stop calling tools and answer, instead of it tracking five below the agent step cap. Clamped to the cap, and passed through to the platform container in `docker-compose.yml`.

### Fixed

- Clearing a stale tool call now drops its arguments as well as its result, on every provider. A turn that writes a hundred rows carries those rows in the arguments and gets an id back, so clearing results alone shed almost nothing and the window kept filling.
- Tool-result clearing now triggers at `min(50% of the context window, 120k input tokens)`. On a 1M-context model the prompt had to reach half a million tokens before anything was shed.
- A long tool-calling turn now sheds its own accumulated tool traffic mid-turn on providers without a server-side context edit, from the step where the prompt crosses that trigger until the turn ends. Needs per-step token usage from the provider, so an endpoint that rejects `stream_options` is not covered. Nothing trimmed inside a turn before: compaction is evaluated at a turn boundary, and only Anthropic served directly had an edit of its own.
- A turn that restarts mid-flight — a context overflow, or a provider rejecting an attachment type, a reasoning effort, or its own echoed reasoning — no longer starts over blind to the tool calls it already executed, so it is far less likely to repeat a non-idempotent write (an upload, a create). The restart carries a bounded list of what already ran, flagging any call that errored as needing verification. Advisory to the model, not an enforced guard.
- An approval or `ask` continuation now inherits the executed tool calls recorded in the reply row, instead of starting with an empty record of them. Calls dropped from the row by an earlier restart are not among them.

## [0.29.0] - 2026-08-21

> **⚠ Breaking — the first controller start after upgrading recreates every sandbox container.** Workspaces (users' files) survive the rebuild; a background job running inside a sandbox does not, so let long-running jobs finish before upgrading. A deployment that already set `SANDBOX_EGRESS_ALLOW` must also `docker compose down` before `up`, because the sandbox network now has a fixed subnet and Docker cannot change one in place.

> **⚠ Breaking — a container with IPv6 but no usable `ip6tables` now refuses to start.** Those rules were previously skipped in silence; if this bites, enable `ip6_tables` on the host kernel.

### Fixed

- `SANDBOX_EGRESS_ALLOW` now has any effect at all: the proxy endpoint never reached the container, so a gated sandbox came up with the open-egress firewall — which, on a network with no route off it, means no internet whatsoever — and was rebuilt on every controller start.
- A sandbox whose entrypoint refuses to start now fails immediately with that entrypoint's own message in the controller log, instead of being handed out as a working session and surfacing later as an unexplained failure on the first tool call.
- The egress proxy now holds a fixed address (`SANDBOX_EGRESS_SUBNET`, `SANDBOX_EGRESS_PROXY_IP`), so recreating it no longer leaves every already-running sandbox permitting the address it used to have — silently, with no egress and no error. A deployment that already set `SANDBOX_EGRESS_ALLOW` must `docker compose down` before `up`, because Docker cannot change a network's subnet in place.
- The sandbox execution image is now refreshed on controller start when it came from a registry, instead of only being pulled when absent — an upgraded controller no longer keeps applying the previous release's sandbox firewall rules. A locally built image (`CAPKA_BUILD=1`) is never pulled over.

### Security

- Sandbox egress now verifies that its default-deny rule is *enforced*, not merely present in the table, and refuses to run otherwise — under a partial netfilter (gVisor) a rule can be accepted and still not filter, and that rule is what separates one sandbox from its neighbours on the shared egress network.
- IPv6 egress rules in the default (open-egress) mode are now fail-closed like the IPv4 ones, instead of best-effort: a v6-capable container that cannot install and verify them refuses to run rather than keeping an unfiltered v6 path to the LAN and to link-local/ULA metadata addresses.
- The container posture fingerprint now covers the resolved execution-image id, so a moved `:latest` counts as a posture change and boot reconciliation stops adopting sandboxes built from the previous execution image.

## [0.28.0] - 2026-08-21

> **⚠ Breaking — a pull-only deployment must follow the new `stable` branch, not `master`.** Coolify: change the branch to `stable`. `CAPKA_BRANCH=master` now requires `CAPKA_BUILD=1`, because images are published for releases only.

### Added

- CI moves a `stable` branch to each release once its images are published, so a pull-only stack gets its compose from the same release as `:latest`, instead of from a commit no published image matches.

### Changed

- `install.sh` and `scripts/update.sh` refuse to pair a development branch with prebuilt images, instead of deploying compose that is newer than anything pullable.
- `install.sh` derives the image tag from the ref it installs (and installs the matching ref for a bare `CAPKA_VERSION=vX.Y.Z`), so code and images can no longer come from different releases.
- `scripts/up.sh` rewrites an existing `CAPKA_VERSION` pin when the caller names a version, instead of only adding a missing one — an upgrade no longer keeps deploying the previous release's images.
- An explicit `CAPKA_BRANCH=master` is no longer silently redirected to the newest release by `install.sh`.

### Fixed

- `scripts/update.sh` no longer leaves a previous release's `CAPKA_VERSION` pin in `.env` when switching refs, which pinned old images against newer compose permanently.
- `scripts/up.sh` no longer prints a successful install while a non-platform service is crash-looping; it checks every service, and forgives a clean exit only from a declared one-shot (`db-init`, `sandbox`).
- `SANDBOX_CPUS`, `SANDBOX_BUSY_LEASE_MS` and `SANDBOX_BUSY_MAX_MS` now reach the controller — they were documented in `.env.example` but never passed through, so setting them did nothing.
- Building from source no longer pulls released `platform`, `sandbox-controller` or `sandbox` images over the ones it just built.

### Security

- With `SANDBOX_EGRESS_ALLOW` set, `egress-proxy` now fails the deployment on a controller image that predates it, instead of idling — an operator can no longer believe sandbox egress is restricted when it is not.
- A manual (`workflow_dispatch`) image build no longer moves `:latest` or the `stable` branch, even when aimed at a tag; it publishes a `sha-<commit>` tag instead, so only a release tag push changes what unpinned deployments pull.

## [0.27.0] - 2026-08-21

> **⚠ Breaking — the first controller start after upgrading recreates every sandbox container.** Workspaces (users' files) survive the rebuild; a background job running inside a sandbox does not, so let long-running jobs finish before upgrading.

### Added

- `SANDBOX_EGRESS_ALLOW` restricts sandbox egress to named hosts (`example.com`, `*.example.com`, `example.com:8443`) instead of the whole public internet. Blank keeps current behaviour; setting it adds an `egress-proxy` service and rebuilds sandbox containers, and needs a current `capka-sandbox` image (the firewall lives in its entrypoint). See SECURITY.md for what it does not cover.

### Fixed

- The `egress-proxy` service no longer crash-loops on a controller image that predates it, which made a stack tracking `master` against the published `:latest` images look like a failed deploy; it logs the mismatch and idles instead.
- Building from source (`CAPKA_BUILD=1`, `npm run docker:dev`) now builds `egress-proxy` as well, instead of pulling a released controller image over the one it just built.
- Stopping a reply now also stops the command running in its sandbox, instead of leaving it to burn CPU and write files until the 300s exec cap. Background jobs (`execute_bash(background:true)`) are unaffected — they are meant to outlive the turn.
- CI now runs the sandbox-controller's two database-backed suites (session store, controller HTTP API); they were skipping silently because `TEST_DATABASE_URL` was set nowhere.
- Turning sandbox egress off now applies to sandboxes that are already running: a live container whose network no longer matches the request is rebuilt instead of reused. Files survive; processes inside it do not.
- Long-term memory no longer spends a full-context model call on a pleasantry ("thanks" → "you're welcome") in a long chat, and no longer skips a short prompt whose answer was substantial. Cuts per-turn aux spend on long chats; memory quality is unchanged or better.

### Security

- Sandbox containers are now rebuilt when the network they should be on changes, so boot reconciliation no longer keeps a container whose posture matches its own (old) network. The container posture fingerprint now covers environment and network too, so the first controller start after upgrading recreates every sandbox once: workspaces survive, background jobs running inside them do not.
- An MCP connector's `env` can no longer set `HOME`, `npm_config_*`, or the XDG/UV cache dirs. A spec pointing `HOME` at the agent-writable `/workspace` got its planted shell profile executed as the `mcp` uid, which holds every connector's secrets.

## [0.26.0] - 2026-08-21

> **⚠ Breaking — the first controller start after upgrading recreates every sandbox container.** Workspaces (users' files) survive the rebuild; a background job running inside a sandbox does not, so let long-running jobs finish before upgrading.
>
> **⚠ Breaking — a reply the model cuts off at its own output-length limit now finalizes as `failed`, not `completed`.** A deployment whose gateway or local model server has a small default `max_tokens` will see ordinary turns marked failed and automations auto-disable after three of them; raise that limit before upgrading.

### Added

- Settings → Usage breaks spend down by provider connection and can filter by one (`?configId=`), so two keys of the same provider are told apart. Spend recorded before this release, and spend whose connection was deleted, groups as "Unattributed".

### Changed

- The monthly spend cap (`tiers.limit_month`) is now the calendar month and resets on the 1st, instead of a rolling 30 days; the "near their monthly budget" alert counts the same window. Existing caps keep their value.
- The app's metadata `description` and the PWA manifest now read "Self-hosted AI coworker. Give it the work, get the finished files." instead of "Personal AI Platform", matching the website; search snippets and the install prompt change on the next deploy.
- `README.md` and `PRODUCT.md` lead with what comes out (finished files) and where the work runs (an isolated sandbox on your server) instead of "workspace, sandbox, file storage". `docs/POSITIONING.md` holds the canonical wording for all four surfaces, including the website in its own repo.
- `SECURITY.md` now states what gVisor costs — host install, syscall speed, a share of `SANDBOX_PIDS_LIMIT`, the `--net-raw=true` egress requirement — next to what it buys, so `runc` vs `runsc` is a decision an operator can make without reading the install script.
- Markdown tables in a reply scroll edge to edge on a phone instead of inside a narrow inset box, and carry a shadow on whichever side still has content off-screen; the frame around them is gone on every screen size.
- Model and icon pickers now sit on the app's field scale, so forms holding them (Add provider, connection rows, project defaults) line up with their own inputs.
- Builds no longer reach out to Google Fonts: Onest and Lora ship in the repo (OFL-1.1), so an air-gapped or slow-egress build box works unchanged.
- Upgraded to Next.js 16.3, which evicts Turbopack's in-memory cache during long `next dev` sessions instead of growing without bound.

### Fixed

- A reply the model cut short at its own output-length limit is now reported as cut off instead of being presented as a finished answer. The partial text is kept and the notice offers Continue; admins see the provider's `length` finish reason and the `max_tokens` lever behind it.
- Deep conversations on providers other than Anthropic (OpenAI, Google, local models) no longer replay the full bodies of old tool results on every turn. The clearing policy that Anthropic applies server-side now also runs when building the context for providers that lack one — same threshold (50% of the window), same keep count (3), and once it engages it stays on until the next compaction checkpoint.
- Long tool-calling turns on Anthropic no longer re-pay for the tool results accumulated during the turn: the cache breakpoint now follows the step tail instead of staying pinned to the last user message.
- Prompt-cache WRITE tokens are now billed instead of priced at zero, which under-reported the cost of every turn on a provider with Anthropic-style explicit caching. The exact rate syncs from the price books into `cache_write_price`; until the next catalog sync those writes are charged at the model's base input rate.
- Approving a tool call (or answering an `ask`) now records the decision and queues its continuation in one transaction, so neither a follow-up already queued in that chat nor a failure between the two steps can leave a decided call that never resumes. A refusal worth retrying keeps the card and its Telegram buttons live; one that isn't (already decided, expired) retires them.
- A worker whose lease already expired can no longer renew it, and now stops at the next step instead of streaming on beside the turn that replaced it in the same project workspace.
- A background job (`execute_bash` with `background: true`) no longer dies when the chat sits idle: the sandbox is leased while the job runs, and each `check_job` renews it. Tune with `SANDBOX_BUSY_LEASE_MS` (default 1h) and `SANDBOX_BUSY_MAX_MS` (default 6h ceiling per job).
- A session running a background job is now evicted last when a user hits `MAX_SESSIONS_PER_USER`, instead of by plain idle order.
- `.env.example` now states the sandbox defaults the code actually uses — `SANDBOX_MEMORY_MB` 512 (was documented as 1024), `MAX_SESSIONS_PER_USER` 5 (was 2), `GC_GRACE_MS` 1 hour (was 7 days) — and documents `SANDBOX_CPUS`, which was missing. Re-check host capacity planning done against the old figures.
- The automation editor's schedule row no longer puts the "Time" label beside its picker with the fields on mismatched baselines.

### Security

- The sandbox's `/opt/mcp` tmpfs (the MCP connectors' `HOME`) is mounted `0700` owned by `SANDBOX_MCP_UID` instead of world-writable, so agent code can no longer plant a shell profile there that the next connector start would source with that connector's secrets in its environment.
- Sandbox containers now carry a `capka.spec` label with their security posture, and the controller recreates any running container whose posture differs from the current build on start — without it a hardening fix like the one above would never reach sandboxes that were already up. On the first start after upgrading, every existing sandbox is torn down (files are kept; a background job running in one is lost).
- Dependency refresh closes three advisories reachable through transitive packages: `ip-address` (SSRF via octal/decimal octet confusion, via `@modelcontextprotocol/sdk`), `brace-expansion` (DoS), and `fast-uri` (host confusion).

## [0.25.0] - 2026-08-15

### Added

- The person card shows 30 days of spend as a sparkline and how many chats and projects the account has (counted, never named — chat titles stay private to their owner), plus a link through to that person's filtered usage: `/settings/usage?userId=<id>`.
- Charts in Settings answer to hover with a styled readout showing cost, calls and the date, replacing the browser's native `<title>` tooltip on the daily spend chart.
- Automations can be created from Settings → Automations (`POST /api/automations`), through the same limits the chat-driven path enforces — the platform switch, the minimum interval and the per-user cap.
- Automations can be edited in the UI — name, instruction and schedule (daily/weekly/monthly/once), via `PATCH /api/automations/<id>`. Schedules created in chat that the simple picker can't represent are shown as-is and left untouched until replaced.
- "Run now" on an automation runs it once off-schedule and opens the resulting chat: `POST /api/automations/<id>/run`. Works on paused automations, refuses (409) while a previous run is still live, and leaves `next_run_at` alone.
- Auto-paused automations now say why and what to do about it, instead of showing a grey badge over a dead switch.
- Settings → Usage → People: each member row carries a link to that person's card in Settings → People (admins only). `/settings/users?user=<id>` opens a card directly.

### Changed

- Pressing a row in a grouped list (recent chats, starter actions, projects, a project's chats) now darkens it instead of shrinking it, so the row no longer pulls clear of its frame and looks cropped.
- The new-chat screen drops the repeated chat glyph and the halo behind the logo, and dates recent chats as "today"/"yesterday" instead of four identical dates.
- Long member lists in Settings → People and Settings → Usage now render 25 at a time with a "Show more" step, and their search fields appear from the sixth member.
- Settings → Integrations is gone as a nav entry; the Telegram bot token moved to Settings → Agent and the old path redirects there.
- The person card's tier picker names the tier the instance default currently points at, so "Instance default" and a tier named "Default" stop reading as the same option.
- Person, capability and automation details open as a centred dialog instead of a right-hand panel. The person card is two columns, folds joined/last-seen/Telegram into one line under the name, collapses sessions and history, and pins Suspend/Remove to a footer.
- Settings → Skills → Permissions leads with the capabilities that carry a rule or an exception; everything on the default moves into a collapsed, searchable, paged list grouped into skills and connectors. Default rows drop the green "Allow" badge, and skills show their description beside the slug.

### Fixed

- Picking a starter action on the new-chat screen now moves the caret into the composer, instead of leaving keyboard focus nowhere when the starters collapse.
- The person card's spend trend and top models count shared-key spend only, matching the window totals beside them instead of exceeding them by the user's own-key usage.
- A chart's hover readout no longer widens the page near the right edge, which had been putting a horizontal scrollbar on the whole window.

## [0.24.0] - 2026-08-15

### Changed

- A message sent while a reply is still running now appears in the chat right away, translucent and where it will land, instead of as a one-line strip above the composer. Each can be edited or cancelled before it goes, and "Send now" stops the running reply and sends the queue immediately.
- Editing a message now edits its attachments too — remove one, add another, paste a file — in the composer, in a sent message and in one still queued, from the same editor.

### Fixed

- A file detached while it was still uploading no longer stays in the workspace, where the file browser and the model both still saw it.
- A message editor no longer clips its own last line when the width changes without typing (rotating a phone, opening the sidebar), and a long paste no longer grows the box past the screen with its buttons below the fold.
- A failed turn is no longer re-streamed three times because its payload happened to contain a number between 500 and 529 — retry now reads the response status, and falls back to the message text only when the provider sends none. Rate limits (429) are still retried.
- A tool call whose arguments arrive as several JSON objects run together is salvaged instead of failing the step; one the provider mangled beyond repair now fails immediately rather than retrying the whole prompt three times.
- `manage skill add {repo}` no longer publishes a catalog to the whole organization: the marketplace row it creates as plumbing is marked `synthetic` and left out of Browse. Adds `plugin_marketplaces.synthetic` (migration applies itself at boot).
- A marketplace apply now reports a genuine write failure as a failure instead of as a stale review, and a stale one carries the full review it was measured against.
- `skill add {repo}` survives a restart or a second replica between the review card and the apply — the reviewed commit is durable, not held in process memory.

### Security

- A hostname resolving into the second standard NAT64 prefix (`64:ff9b:1::/48`, RFC 8215) no longer bypasses the SSRF guard — an AAAA record in that range reached the cloud metadata service. Public IPv4 behind NAT64 still resolves.

## [0.23.0] - 2026-08-14

### Changed

- The model's thinking now renders as Markdown instead of raw text — `**bold**` pseudo-headings, lists and fenced code inside a thought are typeset, at the thinking row's own size.
- The update review dialog leads with what the update will be able to do; the author's file changes moved below it into an expander that now lists the actual filenames.
- A skills repo added as a marketplace no longer advertises a skill count in its description — the count omitted `commands/*.md` and read lower than what an install brings.

### Fixed

- The chat navigator down the right edge now marks the newest turn once the end of the transcript is on screen; at the bottom of a chat it highlighted an older turn, and the last mark could not be reached by scrolling at all.
- The Plugins tab showed `settings.skills.installed.state.on` instead of On / Off / Partly on.
- A connector or skill left behind by a removed plugin now says so, explains that nothing can use it, and offers only Delete. Such a skill was previously hidden from the Library, from every run, and from the Plugins tab at once — reachable from no screen.
- `npm test` no longer needs a local PostgreSQL: the plugin-permission suite's teardown ran outside its `RUN_INTEGRATION` gate and failed the whole file where no database was listening.

## [0.22.0] - 2026-08-14

> **⚠ Breaking — the plugin install/upgrade API moved.** `POST /api/extensions/install`, `POST /api/admin/marketplaces/install` and `POST /api/extensions` (upgrade) now return 410. Installs and upgrades go through `GET /api/extensions/review` followed by `POST` of the `reviewHash` it returns. Any script or integration calling the old endpoints must be updated.

### Security

- A member could delete an org-wide or project permission rule by installing a personal plugin whose resource name matched it — and a missing rule means allow, so this granted what an admin had forbidden. Deleting a rule now requires being an admin (or owning that rule), and only ever a rule that will apply to nothing; each deletion is recorded as `policy.clear`.
- The install review is now the only way to install or upgrade a plugin. Three older endpoints wrote skills, connectors and executable plugin files with no review at all, and the UI silently fell back to one of them whenever the review had not loaded.
- Installing and upgrading now require a writer role again, honour the "members can install plugins" switch, and are rate-limited on both the review and the apply. The new endpoint had briefly admitted viewers and ignored the switch.
- A plugin's bundled files and a skill's support files are no longer writable by an update that lost its lease — previously an interrupted update could overwrite the executable bytes of a completed one, leaving the recorded version and the running code disagreeing.
- A plugin changing an access token, a query value or URL credentials — without changing any header name — now requires consent; it previously showed as no change at all. Connectors that ask for an access key you fill in yourself no longer report a credential change on every update.
- A skill edited directly in the database is now reported as locally modified before an update overwrites it.
- An `https` redirect to `http` is refused instead of forwarding the Authorization header, secret headers, method and body in cleartext.
- A cross-origin redirect from a custom provider base URL no longer forwards the provider API key. Only `accept`, `accept-encoding`, `accept-language`, `content-type` and `user-agent` survive the hop; a redirected `POST` also becomes a `GET` without the body, except on 307/308.
- Host folder mounts now refuse a directory that *contains* a blocked system path, not just one inside it — mounting `/var` previously handed the sandbox `/var/run/docker.sock`. `/lib64`, `/lib32` and `/libx32` are blocked alongside `/lib`. Unrelated subtrees such as `/var/www` stay mountable.
- A suspended or not-yet-approved account kept read access to chats, chat history, workspace files and downloads, projects and the MCP OAuth flows: those endpoints checked for a session but never for account status. `requireSession` now refuses any non-active account, so suspending someone takes effect everywhere rather than only on writes.
- A redirect chain that leaves the original host no longer regains the API key by bouncing back to it, and a cross-origin `307`/`308` carrying a request body is refused outright — the body of an OAuth token request is itself a credential. A provider base URL that answers with a cross-origin `307` instead of proxying will now fail.
- `CAPKA_MASTER_KEY` is validated as 32 bytes of hex at startup; a malformed key previously failed deep inside encryption, or silently weakened the HMACs.
- IPv6 addresses in a connector URL are now evaluated against the network policy instead of being reported as unresolvable.
- An IPv4 address written inside an IPv6 one (`::ffff:a9fe:a9fe`, `::7f00:1`, the NAT64 prefix) is now blocked like the IPv4 address it is; previously only the dotted `::ffff:1.2.3.4` form was recognized, so a hostname resolving to the hex form reached cloud metadata and loopback. An address that parses as neither family is refused rather than allowed.
- Installing skills from a GitHub repo no longer also installs connectors and executable plugin files the approval card never mentioned; a repo declaring them installs its skills and says in the install notes that the connectors were skipped.
- `manage skill add {repo}` now goes through the same install review as every other install: its approval card lists the skills that will actually land (it previously listed only `skills/*/SKILL.md` and silently also installed `commands/*.md`), warns when hand-made edits would be overwritten, names permission rules left applying to nothing, and refuses if the card was not shown. The review is also recorded in the activity list.
- A legacy upgrade path that could erase a running update's claim is removed, and the remaining install path writes a plugin's pin, inventory and bundled files as one fenced unit. An install that fails part-way no longer leaves an empty plugin behind.
- The review no longer offers to delete a permission rule that another source's identically named connector or skill still answers to, and no longer offers a rule the person asking is not allowed to delete (which previously failed inside the apply and left the plugin needing attention).

### Added

- Updating a plugin now shows what it will reach — which addresses its connectors talk to, which program runs in the sandbox, which access details it asks for — with the exact detail behind an expander, and refuses to apply if any of it changed while you were reading. Permission rules left pointing at a removed resource are surfaced with a choice to keep or delete them.
- Plugin apply outcomes appear in the activity list as their own entries (`plugin.apply_accepted` / `_succeeded` / `_stale` / `_blocked` / `_failed`), so an install that did not finish is visible without expanding a row.

### Fixed

- Installing skills straight from a GitHub repo (a repo with no `marketplace.json`) now actually routes them; it previously reported success and installed nothing.
- Browse → Install works again for both admins and members: it now opens the same review screen an update does. It had been left calling the endpoints that moved behind the review, so every first install returned an error.
- A plugin update whose lease expires now records how it ended in the activity list instead of stopping at `plugin.apply_accepted`, and one operation can no longer produce two conflicting outcomes there.
- A connector or skill left behind by a plugin whose install record is gone is no longer offered to the agent, and now shows up under Connectors so it can be deleted — it was previously live, reachable, and invisible on every screen.

- A single dropped realtime event no longer freezes a reply on screen for the rest of the turn: the client holds what it cannot apply yet and replays it once the reply's snapshot catches up, instead of discarding it and waiting for the turn to end. Previously any interruption of the event stream — an SSE reconnect, a Postgres `LISTEN` blip, a payload over the `NOTIFY` size limit — left the user watching a stalled answer while the agent kept working.
- A turn that stalls *after* producing work now says the reply was cut off part-way and offers "Continue", instead of advising a retry — regenerating re-runs every tool and rewrites what the turn already wrote. Telegram gets the same wording, without the button.
- A stalled provider no longer looks like a frozen chat: the "model is not responding — retrying" row now shows even after part of the reply has streamed, where it was previously suppressed (which is every turn on a reasoning model).
- A retry after a stall now waits twice as long as the first attempt before giving up, so a model that is alive but thinking longer than `STREAM_IDLE_SECONDS` (default 60s) is no longer failed four times in a row. Raise `STREAM_IDLE_SECONDS` to scale both windows.
- A Telegram reply is no longer re-sent as plain text when the rich send's outcome is unknown (lost response, 5xx), which could deliver one turn twice; the fallback now runs only when Telegram itself refused the message.
- A worker that lost its lease no longer overwrites the outcome the zombie reconciler recorded: the task status, the assistant message, the realtime event and the Telegram push all hang off one compare-and-set, so a turn already shown as interrupted can no longer flip to an answer.
- The connector health and connect-error caches no longer keep an entry per connector revision for the life of the process; both now hold only what is still within their TTL.
- Upgrading or uninstalling a plugin now releases its connectors' cached tool schemas instead of leaving an entry behind per removed connector, on every upgrade.
- A turn resumed from an approval card now reports the whole turn's tokens, cost and time in its message details, not just the half after the click (the `usage` ledger and budgets were already correct).
- Turns on OpenAI-compatible connections (LiteLLM, vLLM, DeepSeek, Mistral, xAI, Groq, Z.ai) now record real token counts instead of zero — usage is requested per stream, so those turns reach `/settings/usage`, cost analytics and traces as actual spend. A gateway that rejects the request is detected, retried without it, and remembered; `CAPKA_STREAM_USAGE=false` stops asking entirely.
- `OTEL_RESOURCE_ATTRIBUTES` now applies (e.g. `deployment.environment=prod`) — it was read by nobody, because `defaultResource()` does not run the env detector.
- Failed spans carry `error.type` (the exception class, never its message), so an error in the tracing backend says what kind it was instead of arriving red and blank.
- `OTEL_RESOURCE_ATTRIBUTES`, the `OTEL_BSP_*` batch tuning, `OTEL_EXPORTER_OTLP_TIMEOUT` and `_COMPRESSION` are passed into the platform container; previously they were accepted and ignored.

## [0.21.1] - 2026-08-13

### Fixed

- Tracing now actually starts in a Docker/Coolify deployment: the `OTEL_*` and `CAPKA_TELEMETRY_*` variables were not passed into the platform container, so v0.21.0 exported nothing in production regardless of configuration. Redeploy to pick up the updated `docker-compose.yml`.

## [0.21.0] - 2026-08-13

### Added

- Optional agent tracing over standard OTLP: set `OTEL_EXPORTER_OTLP_ENDPOINT` to export a span tree per turn (turn → LLM calls → tool calls → sandbox/MCP work) to any OpenTelemetry backend (Langfuse, Phoenix, Tempo, Jaeger, an OTel Collector). Unset means off with zero overhead; no new services and no vendor SDK.
- Prompts, documents, tool payloads and sandbox commands stay out of exported traces unless `CAPKA_TELEMETRY_CONTENT=true`, plus `CAPKA_TELEMETRY_CONTENT_REMOTE=true` when the collector is not on this host — without the second flag content is force-disabled and the boot log says so. Cost in USD is likewise withheld by default (`CAPKA_TELEMETRY_COST=true`) so the Postgres usage ledger stays the single money truth. Tunable further with `CAPKA_TELEMETRY_SPAN_PREFIXES` and `CAPKA_TELEMETRY_EXTRA_ATTRIBUTES`.

### Changed

- A reply longer than the screen now follows its own tail: the question rises to the top as before, and once the answer fills the view the chat keeps the write head in sight instead of leaving the reader to chase it. Scrolling up stops it; returning to the bottom resumes it.
- Opening a chat lands at the end of the conversation rather than pinning its last question to the top.
- The "scroll to bottom" button appears only when the reader is actually away from the end — it used to sit on screen for most of every streaming turn. It reads as "new message" for a turn that arrived from Telegram or an automation, which no longer pulls the view away from what is being read.
- Reasoning collapses at the end of a turn without animating when it is off screen, and the copy/regenerate row appears just after the height settles instead of during it.

### Fixed

- Opening a spoiler no longer moves the chat. Whatever was driving the view — following a streamed reply, or holding a pinned question — hands over to the row you pressed for as long as its panel animates, so the panel grows out of a control that stays put.
- Thinking is not collapsed out from under you: a spoiler you have touched once is never closed by the app again, and neither is one holding the keyboard focus or a text selection.
- Following a streamed reply stops when the turn does, so a late image, a syntax-highlight pass or a diagram rendering no longer drags an idle chat to the bottom.
- Opening a chat with history stays at the end while it finishes assembling — images decoding and syntax highlighting arriving used to grow content above the landing point and leave a long chat sitting in its middle.
- The on-screen keyboard is one measurement app-wide: the transcript lifted by a different amount than the layout reserved on iOS, because a second copy of the formula omitted `visualViewport.offsetTop` and never listened for its `scroll` event.
- Nothing moves the transcript while a finger is on the screen — a resting thumb suspends following until it lifts, and touching the screen stops an eased scroll at once.
- The "scroll to bottom" pill now actually goes there, and stops showing once you arrive: an explicit jump was measured as drift and undone, so the pill could appear to do nothing.
- A keyboard appearing or dismissing mid-gesture no longer writes over an iOS touch or its momentum — the shift is held back and applied once the gesture ends.
- A reply finishing no longer announces itself as a new message: if you had scrolled up during your own turn, the jump pill flipped to "New message" (and a screen reader said so) when the stream merely ended.
- The chat navigator highlights the turn you are actually reading instead of lagging a message behind it.
- The chat exposes itself as a log region and marks a streaming turn busy, so a screen reader announces a reply once rather than a token at a time.
- Rendered pages in a tool's result reserve a fixed box, so a decoding image can neither push the transcript down nor rewrap the row it sits in.
- The chat no longer jumps when anything above the reader changes height — thinking auto-collapsing, a spoiler closing, a rendered page decoding, or syntax highlighting and diagrams arriving late and re-laying-out the whole history. Previously only Chrome and Firefox absorbed this via native scroll anchoring, which Safari does not implement, so iOS jumped where Android did not.
- Scrolling with the keyboard (PageUp/Home/arrows) releases the pinned turn like the wheel and touch already did, instead of being pulled back on the next streamed delta.
- Streaming is smoother on phones: scroll position is corrected once per height change instead of forcing a layout pass on every one, the reading-line and active-turn tracking no longer measures every message on every scroll event, and nothing writes to the scroll position mid-gesture or during iOS momentum.
- Automations fire at their scheduled time on hosts whose `TZ` isn't UTC — raw queries encoded dates in the process timezone against timezone-less columns, so a `TZ=Europe/Kyiv` box fired them three hours early.

## [0.20.1] - 2026-08-12

### Changed

- Streamed thinking text is no longer blurred at its tail: the effect made words unreadable, and it stayed frozen over finished text whenever the model paused before answering. The caret, the group's ticking duration and the step spinner remain as "still working" signals.

### Fixed

- Sending a message with attachments no longer drops the question down the page: the composer losing its preview tiles shifted the scroll position out from under the pinned turn. Most visible on mobile; plain one-line text was unaffected.
- `/projects` scrolls, so projects past the first screenful are reachable on a phone.
- Admin banners (provider health, updates, org changes) wrap their message on a narrow screen instead of squeezing it into a one-word-per-line column beside the action link.
- Overlays are sized in `dvh`: the file viewer, the settings search results, the add-provider dialog and the chat jump list no longer extend under mobile Safari's toolbar.

## [0.20.0] - 2026-08-12

### Added

- Files a turn changed but never named in its reply appear under the answer, folded behind "Also changed" — or as the main tiles when the reply named nothing at all.
- A question the agent asks with three or more fields is now paged one field at a time, with a pager showing how many are left.

### Changed

- Focus rings meet the 3:1 contrast floor (they measured 2.99:1 in the light theme) and form-field borders are stronger, so a field is findable now that it carries no inset shadow.
- Form fields are flat — tone plus a 1px border, no inset shadow — and multi-line fields now share the single-line surface instead of being transparent.
- Tool steps in the activity rail show the filename, search pattern or skill name as a code chip beside the action rather than spliced into the sentence, matching how the same token looks in an answer; Telegram step lines carry it too.
- Chats that belong to a project are grouped under a single project header in the sidebar instead of each row carrying a project badge, so chat titles are no longer truncated to make room for a repeated name.
- A project page shows its default model's readable name from the synced model catalog (`models.display_name`) instead of the raw model id. A custom model absent from every catalog still shows the id as entered.
- A project page scrolls as one page: the header and tabs used to be pinned with only the tab's content scrolling, which put a scrollbar in the middle of the page and sliced content along the pane's top edge. Every tab now shares one column width, where Overview was 896px and Settings 672px.
- A project page's tabs are a proper keyboard widget: arrow keys move between them, the strip is one stop in the tab order, and each tab points a screen reader at the panel it controls.
- Project rows in `/projects` are clickable across their full width, and the setup line under a project's name (instructions/model/internet) is plain status text rather than a hidden link to Settings.
- A project's memory box appears once the project has at least one chat, instead of asking for "what the assistant remembered" on a project that has never run.
- Deleting a project is available on its Settings tab to any owner, not just admins — it was already available to them on the `/projects` row, and `DELETE /api/projects/[id]` already allowed it.

### Fixed

- The model picker on a project's Settings tab opens fully instead of being clipped to an unusable sliver, which made picking a project's default model impossible. The same fix covers the picker in Connections, Add provider, and the setup wizard.
- Cards on a project page keep their left and right borders; the tab pane was clipping them off at both edges.
- The Files tab no longer runs past the bottom of the window when a provider-status, update, or org-change banner is on screen.
- Sandboxes with egress on can resolve DNS again on hosts whose resolver is a private address (Docker Desktop `192.168.65.x`, corporate DNS, a home router). The egress firewall was dropping the container's own resolver, which looked like "no internet, host DNS ignored". Existing deployments: rebuild the sandbox image (`npm run sandbox:build`) or pull the new one.

## [0.19.0] - 2026-08-11

### Added

- `MCP_ALWAYS_LOAD` (comma-separated connector names) keeps those connectors' tools in the prompt when progressive disclosure is deferring the rest, so a connector the team uses constantly costs no `find_tool` hop. Pinned connectors don't count toward the defer budget. Unset → nothing pinned.
- Remote MCP connectors can speak the legacy HTTP+SSE protocol, not just Streamable HTTP. The transport is inferred from the URL (`…/sse` → SSE); `POST /api/mcp` and `/api/admin/mcp` accept an explicit `transport: "http" | "sse"` for endpoints that don't follow the convention.

### Changed

- Remote (http/sse) MCP connectors no longer connect before the first token: their tools are declared from the schema cache and dialled on the first actual tool call, as stdio connectors already were. A measured handshake is ~0.9–1.7s per connector, previously paid on every turn even when no tool was called. A newly saved connector is warmed by the Connectors health probe, so its tools are available from the first message.
- MCP progressive disclosure caps the always-on connector block at `MCP_DEFER_TOKEN_MAX` tokens (default 8192) on top of `MCP_DEFER_TOKEN_PCT`, so deferral still engages on very large context windows. Set `MCP_DEFER_TOKEN_MAX=0` for the previous percentage-only behaviour.

### Fixed

- Settings → General shows the budget block to everyone the shared-key cap actually applies to. A user with a provider key of their own saw nothing, while their turns on the admin's shared models stayed capped and could still be refused.
- The budget block reports "0 exchanges" instead of rendering nothing for a user who hasn't run a turn in the last 30 days.
- A failed `/api/me/billing` request no longer hides the budget block until a full page reload.
- Editing or deleting an MCP connector now drops its cached tool schemas, instead of leaving the model with the tool list from before the change. Cached schemas are also refreshed in the background every 30 minutes for remote connectors.
- Sending the first message in a new project chat no longer fails with "Project not found".
- Workspace files named in any script (Chinese, Greek, Georgian, …) become file chips and artifact tiles, and can be included in "Download all" — the path charset was limited to Latin and Ukrainian.
- Copy buttons work on plain-HTTP deployments, where `navigator.clipboard` does not exist; they also no longer report "Copied" when the copy was refused.
- Provider content-safety refusals (DeepSeek "Content Exists Risk", Azure content-management policy, OpenAI `content_filter`, Gemini `PROHIBITED_CONTENT`) read as a calm `content_blocked` message instead of the raw provider string.
- A turn that failed because the model stopped responding is localized instead of falling back to English — `provider_unresponsive` had no translation.

## [0.18.0] - 2026-08-11

### Added

- Chats now print (and save to PDF) as a full document: the whole transcript flows instead of one screenful, the sidebar and composer are dropped, collapsed reasoning is expanded, and link targets are printed.
- Shared elevation tokens — `shadow-hairline`/`btn`/`panel`/`raised`/`overlay` and `inset-shadow-field`, plus `--field`, `--hover`, `--hover-strong` and `--border-strong` in both themes.

### Changed

- Streamed reasoning dissolves at its trailing edge while it arrives; the answer body carries a write-head caret instead. Both are static CSS, with no per-token animation.
- The running status line no longer sweeps a shimmer across its label — the spinner beside it already reports the same thing.
- A collapsed activity run reports how many actions it contains, not just how long it took.
- Reasoning text is no longer italic (Onest has no true italic, so Cyrillic was mechanically slanted).
- Text selection uses the palette's accent instead of the browser's default blue.
- The sidebar chat list fades at its bottom edge while more remains scrollable; it previously cut off mid-row with its scrollbar hidden.
- Buttons, menus, popovers, cards and inputs draw their edge from the elevation tokens rather than hand-rolled `ring`/`shadow` pairs, and share one 140ms micro-interaction curve.
- A question the agent is blocked on now sits on a raised panel headed "Waiting on your decision" until it's answered, then collapses to the previous quiet inline form. Its choices are solid when selected, are 40px tall on touch, and Enter submits from a text field.
- "Send" on a blocked question explains why it's unavailable instead of sitting dead.
- The right-edge turn minimap appears from five turns instead of two, and its inactive marks sit just above the 3:1 contrast floor for non-text UI — legible without reading as nine near-black dashes in an empty margin.
- Neutral hover and selected states across the app collapse onto `--hover` and `--hover-strong`, replacing eleven ad-hoc `bg-accent`/`bg-muted` alphas over ~60 call sites; four dilutions of `--border` collapse onto the token itself.
- Dialogs, sheets, menus, the model picker and the floating chat controls take their edge from the elevation tokens instead of a `border` plus a generic Tailwind shadow.
- The workspace panel reads as an overlay on phones and keeps a `--border-strong` seam when docked on desktop, where it previously drew no shadow or emphasis at all.
- `--field` is alpha-based in dark mode, so a sunken input is recessed against every surface — including the sidebar, where the old fixed value came out slightly raised.
- Loading placeholders in settings, the model picker, the sidebar, project hub and automations use the shared `Skeleton` instead of hand-rolled `animate-pulse` divs, which had opted back into Tailwind's slower default cadence.
- Success and warning states use `--success` and `--warning-surface`/`-border`/`-text` instead of raw `emerald`/`amber` palette values with hand-written dark-mode variants. Remaining palette colours are categorical (file type, price tier, audit groups), not states.
- A governance decision (allow / ask / deny) looks the same on every admin screen; in a person's drawer `allow` had been rendering as the least emphasized of the three.
- Expandable sections — activity runs, tool output, technical details, connection and skill rows — grow open and fold shut instead of snapping, in 200ms.
- Segmented controls (settings tabs, the plugins hub, agent mode, connector kind and auth method) are one component drawn as a sunken track with a raised knob. Four of the five were hand-rolled copies with no accessible role, so a screen reader met a row of unrelated buttons.
- Settings and project cards take their edge from `shadow-panel` like every other panel, instead of a hand-drawn border.
- A failed turn reads as a calm panel carrying one red mark, in chat and in settings alike, rather than a red-bordered tinted slab.

### Fixed

- "Reasoned for …" reports the turn's real duration. It was timed from the browser's first paint, so reopening a tab mid-turn restarted the count from zero and froze that wrong number into the transcript for good; the server's own measurement now wins as soon as the turn ends, and a live turn ticks from its true start.
- A turn that calls a tool after it starts answering no longer prints the same duration on every one of its runs — only the first run owns a measured span.
- A turn that failed or was still waiting on you records how long it thought, so its header shows a duration instead of a bare "Reasoning".
- Every expand/collapse chevron in the app turns again. The selector matched Radix's `data-state=open`, which Base UI (in use since the UI rebuild) never sets — it uses `data-panel-open`.
- The chat header fits a phone. Model and thinking depth are one control there — a compact trigger whose overlay carries the model list and the depth slider together — so the row no longer overruns the viewport and pushes the files button off the edge. Desktop keeps both labelled pills side by side.
- A connector's name is no longer said twice in the step rail: MCP servers commonly prefix every tool with their own name, which the branded prefix then repeated ("Silpo · Silpo get my shopping cart").
- Menus, dialogs and sheets read as floating again. The `overlay` rung had one wide soft shadow and no near "contact" layer, so over a busy surface it looked like a smudge instead of a lifted panel.
- Sidebar `outline` menu buttons draw their border again: the previous `hsl(var(--sidebar-border))` shadow was invalid CSS (the variable holds `oklch(...)`) and browsers dropped the whole declaration.
- Right-clicking your own chat message opens the browser's context menu again — the touch long-press handler was suppressing it for mouse input too.
- The context-window ring is legible again: it drew at half-strength `--primary`, under the 3:1 contrast floor for non-text UI.
- `automations-collection` tests no longer fail once the clock passes a hardcoded date; the one-off trigger case now derives its `once_at` from the current time.
- Recent-chat rows no longer paint a hover shadow that their `overflow-hidden` container clipped into a dark smear along one edge.
- The workspace panel's upload control is reachable by keyboard. It was a `<label>` wrapping a `<div>`, with the file input `hidden`, so nothing in it could take focus — the only way to add a file to a workspace was the mouse. It also shows a spinner while uploading instead of a pulsing icon.
- `manage` impact warnings for agent autonomy, sandbox network and private-provider-URL blocking are localized. The translations already existed and nothing read them, so a non-English admin was asked to confirm a security warning written in English.

### Removed

- 31 message keys nothing referenced, a dead `resolveUserModel` wrapper, a `.scrollbar-none` duplicate (shadcn's `no-scrollbar` already provides it), an `animate-step-badge-in` alias identical to `animate-step-in`, and a second byte-for-byte copy of the SSRF-guarded GitHub fetch.

## [0.17.0] - 2026-07-31

### Added

- Thinking depth is now a per-chat control next to the model picker (off / brief / balanced / deep), stored on the chat. It only appears for models that reason, and only offers the levels the chosen model actually accepts.

### Fixed

- A model that accepts only some `reasoning_effort` values (Kimi K3: `low|high|max`, Groq's Qwen: `none|default`) no longer fails the whole turn with "an error occurred". The rejected level is re-mapped onto the enum the provider names in its own error, the turn is retried once, and the enum is remembered on the model so later turns send a valid value first time.
- `reasoning_effort` is no longer hardcoded to `medium` — no such value is portable across providers, and it 400s on several current models.

## [0.16.0] - 2026-07-28

### Added

- Images in the file viewer zoom and pan (wheel, double-click, +/-/0, on-screen controls).
- Files with no in-app viewer (docx, xlsx, zip, media) now open a pane naming the type and size, offering download or asking the assistant to convert the file into something previewable — clicking them no longer starts an unannounced download.
- The file browser accepts dragged-and-dropped files, shows each file's modification date, and can delete a file (behind a confirmation).
- "Copy" in the file viewer's code pane, which previously only existed for code blocks inside a rendered document.

### Changed

- Every "nothing here yet" and "this didn't load" screen now uses one shape (icon, title, one sentence, a way forward), replacing six different geometries across settings, projects, the archive and the workspace panel.
- Settings pages share one layout again: sections, cards, skeletons and inline load errors come from the shared shell on every page, and the stray `Separator` rules and rogue heading sizes are gone.
- Empty settings lists carry an icon and a hint saying what would fill them; six of them were a bare grey sentence in a dashed box.
- Settings pages that load a list show skeleton rows instead of a centred spinner, so the content no longer lands at a different height.
- The non-admin notice on admin-only settings pages keeps the page title and width instead of one grey line in the corner.
- Sign-in and sign-up report a rejected attempt inline next to the fields (wired with `aria-describedby`) instead of only in a toast that fades.
- The context ring in the composer says how full the conversation is and what happens next; the exact token counts are now admin-only, matching the (i) popover.
- Keyboard shortcuts in the command palette and account menu render as `Ctrl+…` off Apple hardware; they were hardcoded Mac glyphs.
- Sign-in switches under Settings → Users save on toggle, like the ones on Security and Agent. Credential fields stay a deferred form with a Save that appears when dirty.
- The archived-chats list uses the same grouped card as the projects list, and both format dates through the active locale.
- The file browser shows a breadcrumb trail instead of a lone Back link, skeleton rows instead of a spinner, and a real empty state; its grid lines tiles up evenly at both panel and full width.
- File type names in the viewer are localized; they were always English.
- The people and permissions drawers keep their title and close button in place while the body scrolls, and the role/tier selects no longer clip their own value.

### Fixed

- Rejecting a pending person under Settings → Users asked for no confirmation and deleted the account on one click; removing a permission exception was likewise unconfirmed.
- A failed `/api/projects` or archived-chats request rendered as "you have no projects" / "the archive is empty"; both now say the load failed and offer a retry.
- The projects list no longer flashes its empty state before the first response arrives.
- Restore, delete, rename, pin and archive report failures instead of silently doing nothing.
- Keyboard users can reach the restore and delete buttons in the archived list; they were invisible until hover, with no `focus-within` escape.
- `⌘⇧F` / `Ctrl+Shift+F` focuses chat search, and expands a collapsed sidebar first. The handler compared against a lowercase `"f"`, which Shift never produces.
- The conversation minimap: opening it with the keyboard moves focus into the list, arrow keys walk it, and its position pills meet the 3:1 contrast minimum.
- The first-run wizard submits on Enter, marks its fields for password managers, names the provider select, and announces "Step 1 of 2".
- Provider and setup failures no longer surface raw English server text or an HTTP status code to a localized UI; the connection test keeps its provider detail as a secondary line.
- The sidebar toggle announced "Toggle Sidebar" in English in every locale.
- The sign-up link disappeared for good on `/login` if the registration-status request failed, and the Telegram button shifted the email field down after mount.
- The "check again" button on the pending and suspended screens gave no sign it had run.
- Sharing a chat is announced as a radio group, the inline rename and share-URL fields have names, and a denied clipboard permission no longer reports a successful copy.
- The open-source link on sign-in and a project's "last chat" line met neither the contrast minimum nor plain-language rule (`—` for "no chats yet").
- File type icons and extension badges are legible in the light theme; every accent was a single dark-theme palette step, leaving white-on-colour badges at ~1.6:1.
- File tiles report their filename to screen readers. They previously announced as unlabelled buttons, or read out the first 600 characters of a text file.
- A file with no viewer behaves the same in list and grid view; the list did nothing at all when clicked.
- Alert dialogs, menus, selects, popovers and tooltips no longer flash back to full opacity for a frame while closing.
- `src/components/chat/file-preview.tsx` is text to git again — a literal NUL byte in a template string had it classified as binary, suppressing its diffs.

## [0.15.0] - 2026-07-28

### Added

- New Settings → Agent page holds everything about what the assistant is: instance-wide instructions, the capability ceiling, autonomy, and the sandbox switch. Exposed to chat as `org.agent_instructions`.
- Instance-wide agent instructions (`agent_instructions`) are prepended to every chat's system prompt, above any project's own instructions. Empty by default, leaving the prompt byte-identical.
- Any user can turn their own long-term memory off on Settings → Memory without an admin. Stored in `user.agent_profile` and folded under the org ceiling, so it can only restrict; exposed to chat as `user.memory`.
- Search over every setting in the settings sidebar, linking straight to the individual row.

### Changed

- Settings → Security now covers the perimeter only: encryption key, network, folders. Agent capabilities, autonomy, and the sandbox switch moved to Settings → Agent.
- Settings → Authentication is now the Sign-in tab of Settings → People, and Settings → Permissions is now a tab of Settings → Extensions. Both old paths redirect.
- The global command palette (⌘K) lists every individual setting, replacing its three hardcoded links to settings pages.
- Turning an agent capability off instance-wide now asks for confirmation, matching the confirm the same change already required from chat.
- Settings pages show skeleton rows while loading instead of a centred spinner, and switch rows toggle from their label.
- Sidebar: projects have a ⋮ menu (new chat in the project, its settings), chat search moved above the projects list, and the duplicate Projects link left the account menu.
- Creating a project now asks for its instructions too, and opens on its Settings tab.
- Sandbox-only controls (code egress, attachable folders) are hidden rather than disabled when the sandbox capability is off, with a line pointing at Settings → Agent to turn it back on.
- Settings pages share one content width and one row layout; nav labels now match page titles ("Providers", "Keys and limits", "Sign-in").
- The project page uses the same sections and rows as Settings, keeps its open tab in the URL, and the project list is a list instead of a card grid.
- `agent_instructions` rejects a non-string value or anything over 20000 characters.

### Fixed

- Members on the shared key with no spend limit now see their own recent usage on Settings → General.
- The project list is reachable from inside a project and from the sidebar heading; instances with five or fewer projects had no link to it at all.
- Creating a project no longer creates two when Enter is held, and an over-long name or instructions no longer surfaces a raw English validation error.
- Hand-drawn radio and segmented controls on Settings → Security and Sign-in now report the selected option to a screen reader.

## [0.14.0] - 2026-07-24

> **⚠ Breaking — `sandbox_enabled` is now enforced.** It previously saved but did nothing (no code read it). If you ever turned "Sandbox execution" off on Settings → Security, the agent will now really lose file and code access: turn it back on there.

### Added

- Agent mode is now also an instance-wide ceiling on Settings → Security — the same preset + capability switches a project has, one level up. It only ever restricts: a project asking for more is clamped, and it is the only way to change agent behaviour for chats that belong to no project. Exposed to chat as `org.agent_*` controls.

### Fixed

- The `memory_enabled` toggle added in 0.13.1 never worked: the key was missing from the settings API allow-list, so it read as 403 and every save failed. It is now part of the agent ceiling, and a test asserts every key a settings page reads is allow-listed.

### Changed

- The org agent ceiling is stored as one validated `agent_profile` setting. The former `sandbox_enabled` and `memory_enabled` keys are read once to seed it, then ignored, so the same fact is no longer stored in two places.

## [0.13.1] - 2026-07-24

### Fixed

- The `memory_enabled` kill switch now has a toggle on Settings → Security, next to agent autonomy. It shipped in 0.13.0 reachable only from chat via `manage`, unlike every other org setting.

## [0.13.0] - 2026-07-24

### Added

- Projects now have an **Agent mode**: a preset ("Assistant" or "Raw prompt") anyone can pick, plus an admin-only allow-list of capability groups (files and code, connectors, skills, managing settings from chat, long-term memory) and two prompt switches (project instructions replace the built-in persona; pass name/date/language). Turning a group off removes its tools *and* the prompt text describing them, so the model is never told about a tool it doesn't have. A tool-less project never starts a sandbox container or a connector process.
- New org setting `memory_enabled` (default on) — an instance-wide kill switch for long-term memory, settable from chat via `manage`. Off stops all memory reading and writing regardless of a project's own setting; saved memories are kept and become usable again when it's turned back on.

## [0.12.1] - 2026-07-24

### Fixed

- Telegram `/model` now lists models from the admin's shared connections, not only the user's own — on a shared-key instance every non-admin got "No models available yet" while the web picker worked. Models from deactivated connections are no longer offered.
- The library's "Browse marketplace" button now opens the Browse view instead of only adding `?tab=marketplace` to the URL.

## [0.12.0] - 2026-07-24

### Added

- Agent run limits are now operator-tunable: `TASK_TIMEOUT_MINUTES` (default 10), `MAX_AGENT_STEPS` (25), `STREAM_IDLE_SECONDS` (60), and `MAX_STREAM_RECOVERIES` (3). Raise `TASK_TIMEOUT_MINUTES` for turns doing heavy sandbox work — the ceiling covers the whole turn, tool calls included. A non-positive or non-numeric value warns at boot and falls back to the default.

### Changed

- `adm-zip` upgraded to 0.6.0, closing a crafted-ZIP memory-exhaustion advisory (GHSA-xcpc-8h2w-3j85). Skill-zip uploads were already guarded by the app's own size/entry/inflate caps.
- Dependencies refreshed to their current patch/minor releases (`next` 16.2.11, `ai` 6.0.235, `better-auth`, `pg`, `zod`, `drizzle-orm`, `vitest`).
- `shiki`, `katex`, `unist-util-visit`, and `@types/mdast` are now declared dependencies. They were imported but resolved only as transitive dependencies of `streamdown`/`ai`, so an unrelated upstream bump could break the build.

### Fixed

- Admin-only UI no longer flashes in after page load: the role now comes from the session rendered server-side instead of being probed over HTTP, which also drops a full user-listing query on first mount and fixes admin controls disappearing when that probe hit a transient 5xx. A role change now takes effect on next navigation rather than persisting stale for the tab's lifetime.

### Removed

- Unused `@ai-sdk/react` dependency and the unreferenced `scripts/seed-skills.mts` skill-seeding script.

## [0.11.0] - 2026-07-19

### Added

- Usage page is now Analytics: completed-turn / active-member / cost-per-completed-turn KPIs, project and channel breakdowns, member/model/project/channel filters, and a "Needs attention" block (projected budget overrun, members near their tier cap, failure spikes, idle seats).
- Optional instance monthly budget on the billing page (setting `usage_monthly_budget_usd`) — drives the budget share on the Spend KPI and the overrun alert.
- Users page: budget bars against tier caps, last session activity, and a per-member drawer (permission exceptions, personal tier assignment, active sessions with revoke, audit history).
- Account suspension: setting a member to "suspended" revokes their sessions in the same transaction and parks them on a dedicated screen until reactivated.
- Permissions: per-user and per-project exceptions (exception-first list, no matrix), an access checker that explains which policy wins, and per-capability change history.

### Changed

- The "Ask" policy effect is labeled "Block until approved" — it has always blocked; the label now says so until a real approval flow ships.
- Admin audit records dedicated `user.suspend`, `user.reactivate`, `user.sessions_revoke`, and `user.tier_change` actions (previously folded into generic status/billing entries).
- Duplicate capability-policy rows are cleaned up and prevented by new DB constraints (migration applies automatically at boot).

### Fixed

- Azure OpenAI model listing now shows the resource's actual deployments (the only runnable model ids) instead of the base-model catalog, whose version-suffixed ids always failed with HTTP 404 (`DeploymentNotFound`). If deployments can't be listed, the catalog is reduced to plausible deployment names, and a deployment name can always be typed into the picker — even when the list is empty.

## [0.10.11] - 2026-07-19

### Fixed

- Azure OpenAI: the model picker now accepts a typed deployment name. Azure's data plane offers no way to list deployments, and the `/openai/v1/models` suggestions are base models — if your deployment is named differently, type its exact name and pick it.

## [0.10.10] - 2026-07-19

### Fixed

- Azure OpenAI connections now accept the portal's full "Target URI" (e.g. `…/openai/v1/responses?api-version=…`) in the Base URL field — the operation path and query are stripped automatically; previously model listing failed on Foundry (`*.services.ai.azure.com`) endpoints pasted this way.
- The model picker's "could not load models" error is now localized instead of always showing in English.

## [0.10.9] - 2026-07-19

### Added

- Azure OpenAI as a first-class provider (modern v1 API): connect the resource endpoint + API key in Settings → Connections; deployments list into the model picker; Responses API by default with a Chat Completions toggle.
- Google Vertex AI as a provider via express-mode API keys (no service-account JSON); Gemini's full multimodal input and Google Search grounding work as with the direct Gemini provider.
- Amazon Bedrock as a provider via long-term Bedrock API keys; the endpoint field takes an AWS Region or a full runtime URL, and the model list resolves inference-profile ids (`eu.anthropic…`) automatically.
- Groq as a first-party connection preset (previously reachable only as a custom OpenAI-compatible endpoint).

## [0.10.8] - 2026-07-16

### Fixed

- The sandbox controller now drains HTTP traffic on `SIGTERM`/`SIGINT`, flushes pending session activity before closing Postgres, and safely retries activity writes after transient database failures instead of silently dropping them; Compose gives this drain an explicit 15-second stop window.

## [0.10.7] - 2026-07-16

### Security

- Resource-intensive workspace archives, paid ask resumes, extension installs/upgrades, and chat clone/fork operations now have per-user token-bucket limits with shared budgets across equivalent endpoints; full workspace archives also require an active account.

## [0.10.6] - 2026-07-16

### Changed

- CI now runs the database-backed runner, durable queue, realtime, billing, Telegram provisioning, automation, and folder-lease integration suites against PostgreSQL 17 instead of silently skipping the product's core persistence paths.

## [0.10.5] - 2026-07-16

### Fixed

- Terminal task payloads, finalized usage records, and governance audit entries now have configurable, replica-safe database retention with conservative per-table defaults and bounded daily cleanup batches.

## [0.10.4] - 2026-07-16

### Fixed

- Deactivating an account now revokes its existing sessions atomically, and sensitive exports, workspace downloads, memory documents, and live event streams require an active account.

## [0.10.3] - 2026-07-16

### Fixed

- File uploads up to the platform's existing 100 MB limit now pass through the Next.js proxy intact instead of being truncated at its 10 MB default.

## [0.10.2] - 2026-07-16

### Added
- The worker now logs a per-minute `ops` health line (heap, RSS, realtime listeners, NOTIFY queue depth, in-flight/aux tasks) so memory incidents can be diagnosed from the log trail.

### Changed
- Tasks now serialize by workspace rather than only by chat, preventing concurrent chats in the same project from racing over shared files, memory, and connectors.
- Added targeted database indexes for sidebar pagination, unread-message probes, and durable task-queue lookups.

### Fixed
- A realtime (SSE) subscription no longer leaks a dead listener when the Postgres LISTEN connection fails mid-subscribe; reconnect storms during a DB blip used to accumulate them.
- An SSE client that stopped reading (sleeping laptop, wedged proxy) is now disconnected once its event backlog passes ~1 MB instead of buffering events without bound.
- Background LLM calls (chat title, memory maintenance, compaction) now carry a 3-minute deadline, so a hung provider request can't pin the whole conversation context in memory indefinitely.
- Streaming flushes are serialized per turn, so a lagging database no longer stacks unbounded concurrent NOTIFY publishes (the source of the pg `client.query() when the client is already executing` warning).
- Guarded provider requests now retire their request-scoped Undici agents after use instead of retaining connection pools across repeated model and OAuth calls.
- Provider model-list failures no longer expose raw upstream errors that may contain credentials, signed URLs, or internal hostnames.
- Existing chats can no longer be retargeted to another project's workspace through a request-supplied project id, and sends are rejected while their project is being deleted.
- The task worker starts its polling fallback before the optional Postgres LISTEN fast path, so an initial LISTEN failure can no longer leave the process unable to claim work.
- A Telegram delivery failure no longer rewrites a successfully completed task as failed; execution state remains durable and the channel failure is logged separately.
- Workspace listings no longer inspect or hash symlink targets outside the workspace, and cached hashes now invalidate after same-size rewrites even when the old mtime is restored.

## [0.10.1] - 2026-07-13

### Fixed
- Share import no longer fails on large Grok/Claude/ChatGPT conversations whose raw payload exceeds the sandbox output ceiling (~1MB): the sandbox script now ships only the fields the importer reads and applies the import caps before emitting.
- sandbox-controller: a single Docker stream frame larger than the exec output ceiling is now dropped and flagged as truncated instead of bypassing the cap. Applies with the next controller image pull.
- The platform image now sets `NODE_OPTIONS=--max-old-space-size=3072` so the Node heap matches the default 4 GB container limit — previously the process crashed with "JavaScript heap out of memory" at Node's ~2 GB default. Override `NODE_OPTIONS` if you change `PLATFORM_MEM_LIMIT`.

## [0.10.0] - 2026-07-13

### Added
- Each project now has a hub at `/projects/[id]` (Overview, Files, Chats), reachable from a new "Projects" section in the sidebar.
- Chats can be moved between projects (or out of one) from the chat context menu.
- New endpoint `GET /api/sandbox/files/archive` streams a complete workspace archive; "download all" and the delete-project dialog use it.

### Changed
- The sidebar's project dropdown is replaced by a "Projects" section; the chat list is no longer filtered by a selected project.
- Creating a project now asks only for a name and description; instructions, model, and internet access moved to the project's Settings.
- Project settings moved out of the modal into a Settings tab on the project hub (fixes the model picker being clipped inside the dialog); deleting a project also moved there.

### Fixed
- Deleting a project now durably tears down its sandbox, workspace, and attached folders and pauses its automations; a failed teardown is retried by the worker.
- A new chat opening on an off-catalog default model (a stealth/preview id typed as a connection's default) no longer false-flags it as unavailable and blocks the composer; the model is now trusted as long as its connection still exists.
- The "model unavailable" notice no longer tells users to pick from a switcher "above" when the picker sits below it.
- The model picker in forms now opens upward when there's more room above the field, and caps its size to the nearest scroll container so it's never clipped below the fold or above a scroller's edge.

## [0.9.2] - 2026-07-13

### Fixed
- The project create/edit dialog no longer overflows the screen with a long system prompt: it caps at the viewport height and scrolls its fields, and the prompt field now grows further before scrolling internally.
- The project default-model field is now clearable back to "use the global default" (a reset control appears once a model is picked).
- Dialogs no longer flash their dimmed backdrop back on for a frame while closing.
- Project cards on the Projects page now align to equal height, and a project's default model shows its friendly name instead of the raw config-scoped id.
- The project memory picker (Settings → Memory) now shows the project name instead of its id.
- "Manage projects" is now reachable from the sidebar project selector, not only the profile menu.

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
