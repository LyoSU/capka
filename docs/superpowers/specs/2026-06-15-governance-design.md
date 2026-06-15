# Governance — Permissions & Audit (Sub-project G1) — Design

**Date:** 2026-06-15
**Status:** Approved (user repeatedly asked for an admin permissions layer; spec→implementation directly) → ready to build
**Part of:** the unClaw extension ecosystem. One governance model across A (skills), B (connectors), C (installed plugins) — administered identically, not by three systems. G1 ships the first functional brick: **allow/deny policy enforced at run time + an audit trail**, with `ask` (human-in-the-loop) designed-for.

## Goal

An admin governs **what the agent may use**, org-wide, from one screen. A `deny` on a skill or connector removes it from the agent's tool set entirely (the agent never sees it). Every governance-relevant action (install, add/remove connector, policy change, enable/disable) is recorded in an **audit trail**. This is the control the shared-admin-key, non-technical audience needs: a single coherent admin surface over every extension.

Non-goals for G1: `ask` / human-in-the-loop tool approval (needs run-loop interception — designed here, built next); per-tool-within-a-connector globs (policy is per skill / per connector in G1); use-time audit of every tool call (high volume — G1 audits lifecycle/admin actions; sampling/use-events later); org catalog allow/blocklist for *install* (the marketplace is already admin-gated; this layer governs *use*).

## Model

A **policy** binds an effect to a capability:

```
effect: 'allow' | 'deny' | 'ask'   -- G1 enforces allow/deny; 'ask' stored + designed-for
capabilityType: 'skill' | 'connector'
capabilityKey: the skill name or the connector (server) name
scope: 'system' | 'user' | 'project'  -- G1 authors 'system' only (admin); user/project forward-compat
```

**Default effect = allow** (opt-out governance — nothing breaks until an admin denies). **Resolution:** most-specific scope wins (project > user > system), mirroring skills/connectors; with no policy, allow. (A future "deny-wins" hardening is additive.)

`ask` in G1: shown in the admin UI but marked "coming soon" and **treated as allow at run time** until the human-in-the-loop gate ships — documented, not silently degraded (the UI says so).

## Data model

```
capability_policies
  id            text pk
  scope         text  default 'system'
  userId        text null -> users.id cascade
  projectId     text null -> projects.id cascade
  capabilityType text          -- 'skill' | 'connector'
  capabilityKey  text          -- skill name / connector name
  effect        text          -- 'allow' | 'deny' | 'ask'
  createdBy     text null -> users.id set null
  createdAt / updatedAt
  index (capabilityType), (scope)

audit_log
  id          text pk
  actorId     text null -> users.id set null
  action      text          -- 'plugin.install' | 'plugin.uninstall' | 'connector.add'
                            --  | 'connector.remove' | 'connector.enable' | 'connector.disable'
                            --  | 'policy.set' | 'policy.clear' | 'skill.add'
  targetType  text null     -- 'plugin' | 'connector' | 'skill' | 'policy'
  targetKey   text null     -- human-readable name/id
  detail      jsonb         -- small structured context
  createdAt   timestamp
  index (createdAt), (action)
```

## Modules — `src/lib/governance/`

- **`types.ts`** — `Effect`, `CapabilityType`, `PolicyInfo`, `AuditAction`, `AuditEntry`.
- **`policy.ts`**
  - `listPolicies()` — all (admin view).
  - `setPolicy({ capabilityType, capabilityKey, effect, scope, userId, projectId, createdBy })` — upsert by (scope, owner, type, key).
  - `clearPolicy(id)` — back to default (allow).
  - `resolvePolicies(userId, projectId)` → `PolicyMatcher`: `{ effect(type, key): Effect }` built from the rows visible to this run (system + own user + project), most-specific wins. Pure-testable given injected rows via `buildMatcher(rows, ...)`.
  - `isUsable(effect)` = `effect !== 'deny'` (G1: deny hidden; allow/ask usable).
- **`audit.ts`** — `audit(entry)` (best-effort, never throws/blocks the action), `listAudit(limit)`.

## Enforcement (run time)

In `runner.ts → prepareRun`, build the matcher once and apply it before assembling tools:
- **Skills:** filter `listAvailableSkills(...)` to those whose `effect('skill', name) !== 'deny'`.
- **Connectors:** `loadMcpTools` gains an `isServerAllowed(name)` predicate — a denied server is **never connected** (saves the round-trip) and its tools never enter the set. The matcher supplies it.
- Sandbox + the `skill` loader tool are core and not policy-gated in G1.

Cache stability: denial changes the tool set deliberately and rarely (an admin action) — the same class of intentional cache invalidation as enabling/disabling a connector.

## Audit wiring (G1)

`audit(...)` is called from the admin actions already in place — best-effort, fire-and-forget:
- marketplace `installPlugin` / `uninstallPlugin` → `plugin.install` / `plugin.uninstall` (+ manifest counts).
- connector `upsertServer` (add) / `deleteServer` / `setEnabled` → `connector.*`.
- governance `setPolicy` / `clearPolicy` → `policy.set` / `policy.clear`.
Actor id is threaded from the route's `requireAdmin()/requireSession()`.

## API — admin-only (`requireAdmin`)

- `GET /api/admin/policies` → `{ policies }` + the current capability inventory (skills + connectors) so the UI can render a row per capability with its effect.
- `POST /api/admin/policies` `{ capabilityType, capabilityKey, effect }` → upsert (system scope).
- `DELETE /api/admin/policies?id=` → clear.
- `GET /api/admin/audit?limit=` → recent entries.

## UI — `settings/permissions` (admin)

A new admin tab, two sections:
1. **Permissions** — every skill and connector listed with a 3-way control (Allow / Ask / Deny). `Ask` is selectable but tagged "coming soon" and behaves as Allow until the gate ships. Denied rows are visually muted. Plain-language helper: "Deny hides this from the assistant for everyone."
2. **Activity** — the audit log: who did what, when, in friendly phrasing ("Admin installed plugin X", "Connector Y disabled"). uk-formal.

## Security

- All policy + audit endpoints are `requireAdmin`. G1 authors only `system` scope.
- `deny` is enforced server-side at tool assembly — a denied capability cannot reach the model even if a client is tampered with.
- Audit is append-only via the API (no delete endpoint in G1).
- `audit()` is best-effort and wrapped so a logging failure never breaks the governed action.

## Testing (vitest)

- **Unit (pure):** `buildMatcher` — most-specific scope wins; default allow; deny hides; `isUsable`. 
- **Service:** policy upsert/clear round-trip (effect change); resolve filters a denied skill/connector out of a sample set.
- **e2e (manual):** deny a connector → it disappears from the agent's tools; the audit log shows the policy change + a prior install.

## Forward-compat

- `effect='ask'` column + UI option exist now; the human-in-the-loop gate (pause tool call → confirm in UI → resume) activates them without schema change.
- `scope='user'|'project'` + owner columns allow personal/project policies later with no migration.
- Per-tool globs: `capabilityKey` can hold `mcp__server__*` patterns when tool-level policy lands.
- Use-time audit events slot into the same `audit_log`.
