# unClaw — Modernization Design

**Date:** 2026-06-08
**Status:** Draft for review
**Author:** brainstorm (lyo + Claude)

---

## 1. Context & Goal

unClaw is a self-hosted AI platform built by a previous AI assistant. It works but is unfinished, and carries architectural debt. This document consolidates a competitive study (5 research scans: Onyx, Suna/Kortix incl. code-level, the self-hosted-chat landscape, agentic/computer-use solutions, Claude.ai office-worker UX, module-system patterns, and 2026 trends) plus a critical code review into a single direction and a phased roadmap.

**Goal:** evolve unClaw into a modern, reliable, secure, agent-flexible platform — without losing its moat (simplicity of self-host + non-developer UX + persistent agentic sandbox), and without painting the architecture into corners ("no problems later").

Existing stack (kept): Next.js 16, React 19, AI SDK 6, Drizzle + Postgres, better-auth, own Docker sandbox via a separate `sandbox-controller` service, Telegram bot, multiprovider (Anthropic/OpenAI/OpenRouter/Ollama).

### Guiding philosophy — clean & minimal (principle #1, overrides convenience)

This is the founding value and the original brief ("less code, less weird logic, more modern and clean"). Every decision below is filtered through it:

- **Minimal core, extensibility over baked-in features.** New capabilities arrive as modules (MCP/Skills), not as weight in the core. The platform stays small; the ecosystem grows.
- **Less code: reuse before adding.** Prefer what the platform already gives (AI SDK, Postgres, the existing Docker isolator) over new dependencies or hand-rolled machinery. Delete home-grown code when a dependency already does it (e.g. the 335-line chat-state hook vs `@ai-sdk/react`).
- **One backend, one container.** Postgres only; no Redis/RabbitMQ/Vespa. Fewer moving parts = fewer failure modes and a self-host anyone can run.
- **YAGNI, ruthlessly.** No enterprise machinery (SCIM/SSO/marketplace/payments) until a paying need exists. Each feature and dependency must justify itself.
- **Clean boundaries.** Small, single-purpose units with well-defined interfaces; when a file grows large, it is doing too much.
- **No magic, no weird logic.** Behaviour should be obvious from reading the code; truth lives in Postgres, not in process memory.

---

## 2. Positioning

**Thesis:** *A self-hosted platform where the AI safely does work in the background and remembers you* — the self-hosted, BYO-API equivalent of "Claude Cowork" for non-technical individuals and small teams.

NOT "another self-hosted chat" (a crowded market: LibreChat ~34k★, Open WebUI, Lobe Chat). The differentiator is **execution** (the agent does the work in a persistent sandbox), not retrieval or chat polish.

**Honest competitive stance:** unClaw is *not* "better than Suna" as an agent platform — Suna is more mature, better funded, technically deeper (delegates its loop to OpenCode, microVM isolation, warm pools, 3000+ connectors). unClaw wins only by being a **different product for a user Suna does not serve well**: the non-technical individual/small team wanting a private, simple, self-hosted assistant. Suna is drifting up-market into a "company OS / GitHub-for-agents"; that leaves the down-market non-tech space open. Structural advantages Suna cannot easily copy: Ollama/offline (their billing assumes a cloud gateway), radically simple self-host (they require Supabase + Daytona), Telegram, non-developer UX.

**Claude Cowork / ecosystem compatibility (by adopting open standards, not cloning a closed product):** maximize practical compatibility with the Claude ecosystem so users and content are portable — *"bring your Claude Skills, run them private, self-hosted, on your own keys."*
- **Adopt the Agent Skills format verbatim** — `SKILL.md` with Anthropic's YAML frontmatter (`name`, `description`), progressive disclosure, bundled scripts executed in the sandbox. A skill written for Claude runs in unClaw unchanged. (This also fixes the module-format choice: reuse the standard, don't invent one — principle #1.)
- **Full MCP**, both directions: host (connect external servers) and server (expose unClaw to Claude Desktop/Cowork).
- **Adopt Anthropic's memory-tool conventions** (`memory_*` filesystem tool), as Suna did.
- **Cowork workflow parity:** delegate → plan → approve → deliverable; Projects; Artifacts; background/scheduled tasks.
- **Import/export** of projects/chats for easy migration from Claude.
- **Consume Claude Code plugin marketplaces** (`.claude-plugin/marketplace.json` → `.claude-plugin/plugin.json`). Resolve plugin `source` (github / git-url / git-subdir / npm / relative), then import the portable components and gracefully skip CLI-specific ones:
  - *Skills* (`skills/**/SKILL.md`) — ~100% portable → sandbox skills (namespaced `unclaw:<plugin>:<skill>`).
  - *MCP servers* (`.mcp.json` / `plugin.json.mcpServers`) — ~95% → MCP registry; remap `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` to local paths; prefer remote, run stdio only inside the sandbox.
  - *Agents* (`agents/*.md` YAML frontmatter) — ~90% → personas.
  - *Skip/adapt:* hooks, LSP servers, themes, monitors, output-styles (CLI-specific).
  This gives unClaw the existing Claude Code marketplace ecosystem (incl. git-based team marketplaces) for free (principle #1: reuse standards).
- *Honest limits:* Cowork is a desktop agent operating on the user's literal local files/apps; unClaw's execution surface is the server-side sandbox + connectors + uploads (trade-up: privacy + self-host + BYO-key). Compatibility is with Anthropic's *open standards*, not Cowork's internal protocol. Skills assume Claude models and may behave differently on GPT/Ollama.

**Non-goals (the trap to avoid):** enterprise orchestration, RBAC/SCIM/SSO, agent marketplaces at scale, agentic commerce/payments, cloning Suna's connector breadth. Chasing these = losing to Suna head-on. Stay simple and user-centric.

---

## 3. The Four Pillars

1. **Reliable core (Postgres-only):** durable agent-task queue, cross-process realtime via LISTEN/NOTIFY, secrets root-of-trust outside the DB. (Phase 0)
2. **Persistent agentic sandbox:** the wedge. Per-project workspace with git-backed version history under the hood; hardened lifecycle; pluggable backend behind an interface. (Phase 1)
3. **Non-tech office-worker UX:** north star = Claude.ai (Projects, Artifacts, file analysis, "delegate a task → plan → approve → deliverable") — but with real execution. (Phases 2–3)
4. **Module/extension system (MCP-based):** MCP servers + Skills (Anthropic Agent Skills format, verbatim) + personas, with safe execution via the existing sandbox. Installable from existing Claude Code plugin marketplaces (portable parts). Teams add their own modules; the answer to Suna's connector breadth without cloning it. (Phase 1+)

---

### UX model — Cowork-aligned (reference: the Claude Cowork desktop UI)

Top-level information architecture mirrors Claude Cowork so users feel at home, and it maps cleanly onto unClaw's architecture:

- **Single mode — the agentic task workspace (NO mode switcher).** unClaw is *only* the Cowork experience: you delegate a task, the agent does it. No separate Chat or Code mode (principle #1 applied to the product itself). Simple Q&A is just a task that needs no tools — the agent answers directly, and the sandbox spins up **lazily, only when a task actually needs it** (this also removes the per-message workspace snapshot, a P1 fix). A code-focused sub-agent (OpenCode-in-sandbox) remains a possible far-future capability, not a UI mode.
- **Task-centric, not chat-centric.** Primary action is "New task"; copy is delegation-flavoured ("Let's knock something off your list"). Items are *tasks* with status (active/running/done), pinnable, listed under Recents. This is exactly the durable task model (Phase 0) surfaced in the UI — the durable queue powers the task list and live status for free.
- **Sidebar:** New task · Projects · Scheduled · Live artifacts · Customize (Dispatch deferred).
  - *Projects* = per-project workspace (pillar 2).
  - *Scheduled* = background/async + cron tasks (built on the durable queue; Phase 3).
  - *Live artifacts* = Artifacts (Phase 3).
  - *Customize* = personas / skills / modules (pillar 4).
- **Home input:** one box with attach (+), project scope ("Work in a project"), a mode toggle ("Ask" vs act/agent), and a model + reasoning-effort selector (e.g. "Opus 4.8 / High"). Plus contextual suggested actions ("Get to work with …").
- **Workspaces:** Org (Team) vs Personal switcher; **Analytics** in the account menu = the usage/cost dashboard (data captured Phase 0/1, dashboard Phase 3). Roles exist; add org/personal workspace scoping.
- **Safety as first-class:** onboarding surfaces "how to use safely"; pairs with the approval gates in §9.
- **Usability bar (hard requirement):** built for ordinary, non-technical office workers (legal, finance, HR, ops, marketing) — NOT the programmer-complex UX of typical self-host tools. No jargon, no YAML/config in the user's face, plain-language everything, sensible defaults, guided onboarding with ready-made task templates. If a non-developer can't use a feature unaided, it's not done.
- **Visual design (hard requirement):** the current UI is plain/templated/generic — replace it with a fresh, modern, genuinely polished and *clear* look (Phase 2). Clarity above all; distinctive but calm; not the default-shadcn/AI-generated feel. Reference quality bar: Claude Cowork's UI.
- **i18n (set up early to avoid a retrofit):** English default, Ukrainian as the second locale, with **automatic detection from the browser `Accept-Language`** plus a manual switcher (the Language menu). Use a standard library (e.g. `next-intl`). All new UI strings go through i18n from the start of UX work; existing strings get migrated during Phase 2.
- **Minimal stance:** adopt the task-centric IA (single mode), project scoping, analytics, scheduled. Defer Voice and Dispatch until justified.

## 4. Architecture Decisions (locked)

Each decision is justified by the future problem it avoids.

- **Keep Next.js.** The pain is architectural (long agent work in the request lifecycle), not the framework. Switching frameworks at MVP burns the most valuable existing code (React + shadcn UI = the non-tech UX moat) for zero user value and reintroduces bugs. The durable queue makes worker location an implementation detail, so this is reversible.
- **Postgres as the single backend** (durable queue + LISTEN/NOTIFY + pgvector). No Redis/RabbitMQ/Vespa. Fewer moving parts = fewer ops failures; preserves the simplicity moat (cf. Suna's mandatory Supabase + Daytona).
- **Own agent loop on AI SDK 6**, modernized with `ToolLoopAgent`, `prepareStep`, `needsApproval`. Not Mastra (a layer over the same AI SDK, duplicating what we have), not OpenCode/OpenHands as the core engine (coding-agent ontology; a double agent loop; multi-tenant isolation issues; fast-moving API → coupling). OpenCode is reserved only as a possible far-future code-focused sub-agent run *inside* a user's sandbox — not a product mode.
- **Worker in-process in Next, behind the durable queue.** Single container (moat). Durability comes from DB lease/heartbeat, not from process longevity. The queue abstraction lets us extract the worker into a separate service later (Suna's Next-web + Hono-api shape) with no change to the rest — reversible by design.
- **State model: per-project workspace + git-backed versioning under the hood.** Isolation between projects (no cross-contamination), undo/history/audit for free (no "agent destroyed my files" incidents), matches the Claude Projects mental model. Git is an implementation detail, surfaced to users as "version history / restore / undo" — never as git jargon.
- **Secrets: root-of-trust outside the DB** (`UNCLAW_MASTER_KEY` env / secret file), with a backward-compat fallback + migration. **Credential-broker pattern** (from Suna): provider API keys and module secrets are injected server-side and never enter the sandbox.
- **Module system: MCP (remote HTTP/SSE, registry in DB) + Skills (folders mounted into the sandbox) + personas (extend `projects`).** stdio MCP servers run only inside the sandbox container, never on the host (avoids the Open WebUI RCE class). Untrusted module code executes only in the existing Docker isolator.
- **Usage/cost capture from day one.** Instrument the runner/task when we rebuild it (Phases 0/1); the admin dashboard + per-user budgets/quotas come in Phase 3. Avoids losing historical data and touching the hot path twice. Also defuses the shared-admin-key footgun.

---

## 5. Target Data Model (sketch)

New/changed tables (Drizzle). Designed up front to avoid migration churn.

- `tasks` (existing) → add `lease_expires_at timestamptz`, `heartbeat_at timestamptz`, `worker_id text`, `cancel_requested boolean default false`, `attempts int default 0`. Index on `(status, lease_expires_at)` for the claim query.
- `usage` (new): `id`, `task_id`, `message_id`, `user_id`, `provider`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd numeric`, `created_at`. Indexes on `(user_id, created_at)` and `(model)`.
- `mcp_servers` (new): `id`, `scope` (`user`|`team`), `user_id`, `name`, `transport` (`http`|`sse`), `url`, `enabled`, `allowed_tools jsonb`, `encrypted_headers text`, timestamps. Index on `(user_id)`.
- `module_secrets` (new): `id`, `owner_scope`, `user_id`, `name`, `encrypted_value`, `created_at`. (Mirrors `providerConfigs` encryption.)
- `projects` (existing) → add `icon`, `allowed_tools jsonb` (which tools/MCP/skills this persona may use), and treat as the "persona/agent" entity. The git workspace is keyed per project.
- `skills` (new, optional in Phase 1): `id`, `scope`, `user_id`, `name`, `description`, `path`/`blob_ref`, `enabled`. Surfaced via progressive disclosure (name+description in the system prompt; full `SKILL.md` read on demand inside the sandbox).
- Provider/master-key handling stays in `settings` + `crypto.ts`, but `getMasterKey()` reads env first.

---

## 6. Critical Code Review (the sins → where they get fixed)

P0 (Phase 0): in-memory `eventBus` + `running` Map pinned to one process (`src/lib/events.ts`, `src/lib/tasks/runner.ts:13`); zombie tasks (fire-and-forget IIFE, DB stuck at `running`); encryption theater (master key plaintext in DB, `src/lib/settings.ts:19`, also the better-auth secret).

P1 (Phases 1–2): hand-rolled 335-line chat-state hook duplicating `presenter.ts` while `@ai-sdk/react` sits unused; naive+costly memory (LLM call every message, recency `limit(50)`, Jaccard dedup); workspace snapshot `find` on every POST (`src/app/api/chat/route.ts:78`); shared-admin-key footgun (`src/lib/providers/resolve.ts`); stdio MCP launched via `npx` on the host (`src/lib/mcp/config.ts`).

P2 (later): two message formats in `presenter.ts`; type holes (`any[]`, `as never`); history silent truncation `limit(100)`; default `create-next-app` README; GCM IV 16 bytes (spec is 12).

---

## 7. Roadmap

- **Phase 0 — Foundation (reliability + security).** Durable queue + NOTIFY realtime + secure master key + zombie reconciliation + usage capture instrumentation. *Approved; detailed in §8.*
- **Phase 1 — Agent & sandbox (the wedge).** `ToolLoopAgent`/`prepareStep`/`needsApproval`; sandbox lifecycle hardening (reap/resume), network policy, resource limits; `SandboxProvider` interface (pluggable backend); per-project git workspace; MCP registry + Skills (module-system MVP); credential broker; approval gates + audit log.
- **Phase 2 — Less code + UX.** Adopt `@ai-sdk/react`/dedupe chat-state; memory v2 (gated extraction + pgvector semantic recall, optionally git-file memory à la Anthropic `memory_*`); **i18n setup (next-intl: EN default + UA, browser `Accept-Language` detection + manual switcher) and migration of existing strings**; non-tech usability pass (plain language, templates, guided onboarding); UI polish; Projects UX; file-analysis flow; visible reasoning/action stream.
- **Phase 3 — Differentiators.** Artifacts (panel + share links, MCP Apps), background/async agents (deliver result to Telegram), admin usage dashboard + per-user budgets/quotas, custom personas/agent templates (Template-vs-Instance sharing), 1–2 connectors (Drive/GitHub), citations, optional Research mode.

---

## 8. Phase 0 — Detailed Design

**A. Durable agent-task queue (Postgres).**
- A task is a row, not a fire-and-forget promise. The worker claims work atomically with `UPDATE ... WHERE status='queued' ... RETURNING` using `FOR UPDATE SKIP LOCKED` (pattern confirmed in Suna's warm-pool). On claim: set `status='running'`, `worker_id`, `lease_expires_at = now() + lease`, `heartbeat_at = now()`.
- The worker heartbeats (`heartbeat_at`, extend `lease_expires_at`) on each `finish-step`. Cancellation = set `cancel_requested=true`; the worker checks it each step and aborts (works cross-process, replacing the in-memory `running` Map).
- Library: prefer a thin Postgres-backed job runner (graphile-worker) or a hand-rolled claim loop; decided at implementation time. Keep it minimal — a single queue, no fan-out.

**B. Cross-process realtime (LISTEN/NOTIFY).**
- Replace the in-memory `eventBus` with Postgres `NOTIFY user_<id>` from the worker and `LISTEN` in the `/api/events` SSE route (one dedicated `pg` connection per SSE stream).
- NOTIFY payload limit (~8KB): small `text-delta` events go inline; large tool results send a lightweight "result ready" signal and the client re-reads from the DB (progressive persist already writes `parts`). Keeps us Postgres-only.

**C. Secure master key.**
- `getMasterKey()` reads `UNCLAW_MASTER_KEY` (env/secret file) first. If absent, fall back to the DB value with a loud warning. Provide a one-shot migration command for existing installs. Document that the key must live outside the DB in production.

**D. Zombie reconciliation.**
- On worker start and periodically: tasks with `status='running'` and `lease_expires_at < now()` → `status='failed'` (or re-queued if `attempts < N`). The UI stops showing eternal "running". The reconnection check in `use-background-chat.ts` then reflects truth.

**E. Usage capture (instrument-only in Phase 0).**
- In the rebuilt task runner, on finish read AI SDK `usage` and write a `usage` row (compute `cost_usd` from a pricing catalog; if unknown, store tokens and leave cost null). No UI yet — just collect.

**Acceptance for Phase 0:** kill the worker mid-task → the task is reconciled or resumed, never stuck "running"; cancel works across processes; SSE delivers across a simulated second instance; provider keys decrypt with the env master key; usage rows are written per task.

---

## 9. Security Model (cross-cutting)

- **Sandbox-as-security** (the strongest, under-marketed advantage): untrusted code (skills, stdio MCP) runs only in the Docker isolator (`CapDrop: ALL`, `no-new-privileges`, non-root, pids/mem/cpu limits, `NetworkMode: none` default). This is the antidote to the 2026 prompt-injection wave (browser-agent RCE classes). Make it a *sold feature*.
- **Approval gates** (`needsApproval`) for dangerous actions; **audit log** (who/what/when) for teams/compliance; **network allowlist** per project/module; tool results wrapped as untrusted.
- **Credential broker:** secrets injected server-side at call time, never in skill files, persona templates, or the sandbox.
- **Module install permissions** by role: `admin` = team-wide modules, `user` = personal MCP/personas, `viewer` = none.

---

## 10. Open Questions / Out of Scope

- Memory v2: pure pgvector vs hybrid with git-file memory — decide in Phase 2.
- Whether to extract the worker into a separate service — deferred; reversible via the queue.
- Realtime voice, agentic payments, agent-identity/KYA — out of scope (hype without substance or legal risk).
- Public module marketplace — only after a Template-vs-Instance sharing format exists; private/team registry first.

## 11. Implementation Notes

- This is Next.js 16 with breaking changes vs prior knowledge (`AGENTS.md`). Before writing code, read the relevant guides in `node_modules/next/dist/docs/`.
- Pin bleeding-edge deps; heed deprecation notices.
