# Plugin install review — design

**Date:** 2026-08-13
**Status:** approved design, not implemented

## 1. Purpose

A marketplace plugin install routes skills, MCP connectors and bundled files into
the instance. Today the operator sees a file-level diff of the target commit
(`UpgradePreview`) but nothing that says *what the plugin will reach*: which hosts a
connector talks to, which third-party command runs in the sandbox, which secrets it
asks for, whether it wants OAuth.

This feature builds that view, derives it from what the install would actually
produce, shows it before anything is written, and blocks an upgrade that widens
access until the authorized installer accepts it.

### Non-goals

These are decided out of scope, not deferred by omission:

- **No enforcement.** Nothing here restricts what installed code may do at runtime.
  The security boundary is the sandbox, not a declaration (see `SECURITY.md`).
- **No per-plugin network policy.** A sandbox is per session (`projectId ?? chatId`),
  shared by every stdio connector in that project, so a per-plugin egress allowlist
  cannot be enforced without a container per plugin.
- **No `intercept`-style attenuation.** Restricting one consumer's access to a
  provider is enforcement; it belongs to a different feature.
- **No author-declared manifest block.** The surface is derived, not declared; a
  declaration would be empty for every plugin that exists today.
- **No provable rename.** See §6.

Naming: this is an *install review* and a consent gate. It is not a capability
manifest and must not be described as one in code, docs or UI copy.

## 2. Product decisions

1. **Informed consent + audit**, no enforcement.
2. **Derived** from what the install produces, not declared by the author.
3. Only an upgrade that **widens** access requires an explicit accept; a first
   install's own Install button is the consent, with the review on screen.
4. **Two registers**: plain sentences for everyone, exact detail behind an expander
   for the authorized installer (system scope → admin, personal scope → owner).

## 3. Invariants

These are load-bearing. A change that breaks one changes the feature's guarantee.

1. **URL validation stays layered.** `assertSafeUrl` remains in `upsertServer` and in
   `connectMcpServer`, and the guarded fetch keeps re-validating every request and
   redirect hop. The review's preflight is a fourth, non-throwing check for display —
   it replaces none of them.
2. **Values never enter a durable or client-visible projection.** Only names of
   secrets, headers, env vars and query parameters. No URL credentials. No content
   hashes outside the server-only projection.
3. **No write happens before the claim is won.**
4. **Runtime sees only a committed view.** A plugin mid-apply or failed is invisible
   to the agent, without changing anyone's `enabled` choice.
5. **A proven rename does not exist** in the current manifest format.
6. **The consented artifact is what applies.** Every input the decision depends on —
   including baselines, policy dispositions and observations — is covered by
   `reviewHash`.

## 4. Data model

### Three projections

| Projection | Lifetime | Contents |
|---|---|---|
| `ResolvedPluginPlan` | one request, in memory | exact `ServerDef`s, file contents, env/header **values** |
| `StoredInstallSurface` | `pluginInstalls.manifest` | redacted execution shape, content hashes, keyed fingerprints |
| `PublicInstallSurface` | client + audit | names, `credential changed` markers, no hashes, no values |

`ReviewResponse` (ephemeral, to the authorized installer only) may additionally carry
the literal `command` and `args`. It must never be persisted. The type boundary
enforces this:

```ts
projectPluginReview(...): {
  response: ReviewResponse;          // ephemeral
  durable: DurablePluginReview;      // audit payload
  storedAfter: StoredInstallSurface; // next baseline
}

insertPluginAudit(tx, review: DurablePluginReview, event: PluginApplyEvent): Promise<void>
```

`insertPluginAudit` cannot accept `ReviewResponse`, so the raw command line cannot
reach the journal by accident.

### Surface shape

```ts
InstallSurface {
  schemaVersion: number;
  completeness: "derived" | "reconstructed" | "unknown";
  connectors: SurfaceConnector[];   // sorted by originKey
  skills: SurfaceSkill[];           // sorted by name
  files: { count: number; bytes: number; rootHash: string; entrypoints: string[] };
}

SurfaceConnector {
  name: string;
  originKey: string;                // manifest path + server key; valid WITHIN one commit
  transport: "http" | "sse" | "stdio";
  endpoint?: { scheme: string; host: string; port: number; pathname: string; queryKeys: string[] };
  authKind?: "token" | "oauth";
  secretKeys: string[];             // header / env NAMES only
  needsSecret: boolean;
  command?: string;
  args?: string[];
  runsThirdPartyCode: boolean;      // always true for stdio
  bundled: boolean;
}

SurfaceSkill { name: string; originPath: string; instructionHash: string; filesRootHash: string }
SurfaceFile  { path: string; bytes: number; contentHash: string }
```

Normalization: host lowercased, port always explicit (443/80 filled in), `pathname`
without a trailing slash, `queryKeys` sorted, arrays deterministically ordered.
`entrypoints` reflects reality: `plugin-runtime.ts` makes exactly one path executable
— `spec.command`, and only when it points inside the plugin root.

Content hashes are over **raw bytes with no normalization**. A whitespace-only edit
therefore reads as a change. That is deliberate: normalization is itself an attack
surface (zero-width characters, homoglyphs), and in a consent feature a false
positive is cheap while a false negative is not. `rootHash` is a hash over sorted
`(path, contentHash)` pairs, so it is path-bound and order-independent.

### Observations are not part of the surface

```ts
ReviewObservations {
  urls: Record<string, "allowed" | "blocked" | "unresolved" | "invalid">;
  detectedAuth: Record<string, "token" | "oauth">;
  policy: { blockPrivate: boolean };
  observedAt: string;               // NOT hashed
}
```

A DNS or OAuth-discovery result is a live fact about the world, not a property of the
pinned artifact. Storing it in the baseline would make the next upgrade compare a
fresh observation against a stale one as if the plugin had changed.

### Fingerprints

```
fingerprintKey = HMAC(masterKey, "capka:plugin-surface:v1")
fingerprint    = HMAC(fingerprintKey, canonicalTypedValue)
```

`canonicalTypedValue` includes the field path (e.g. `connector.args[2]`) so the same
secret in two contexts does not produce interchangeable fingerprints. Composite
values are length-prefixed, never concatenated: `"a" + "bc"` and `"ab" + "c"` must not
collide. A keyed HMAC rather than a plain digest, so a low-entropy value cannot be
recovered by brute force. `crypto.ts` gains a `fingerprint(value, keyHex)` helper;
`sandbox/client.ts` already uses `createHmac` the same way.

### Stored manifest, versioned

```ts
type StoredPluginManifestV2 = {
  schemaVersion: 2;
  inventory: InstallManifest;            // last committed
  installSurface: StoredInstallSurface;  // last committed
  /** Bumped on every committed view replacement. The claim's CAS compares it, so an
   *  apply that was planned against an older committed state cannot win. */
  committedRevision: number;
  applyState?: {
    operationId: string;
    targetSha: string;
    status: "applying" | "failed";
    startedAt: string;
    leaseExpiresAt: string;
  };
};

type PluginApplyEvent = "accepted" | "succeeded" | "stale" | "blocked" | "failed";
```

A legacy row has no `committedRevision`; `readStoredManifest` reports it as `0`, which
is the value a first claim expects.

`pluginInstalls.manifest` is already `jsonb`, so no column is added — but the column
is typed `Record<string, unknown>`, meaning a shape change is invisible to the
compiler. Hence the discriminator: legacy rows are detected by the **absence** of
`schemaVersion`. All reads go through one function:

```ts
readStoredManifest(row): { inventory: InstallManifest; installSurface: StoredInstallSurface | null }
```

Outside `install.ts` exactly one place reads this column today —
`marketplace/service.ts` (`displayName`, `notes`, `commit`) via an inline cast. Under
V2 those move under `inventory`, so without a central reader that call site would
silently render blanks. No backfill: a legacy row is upgraded lazily on its next
apply.

## 5. Function contract

```
buildPluginPlan(gh, only?)        → ResolvedPluginPlan   fetch + parse + preflight; no persistent writes
projectPluginReview(plan, base)   → { response, durable, storedAfter }
applyPlanResources(plan, tag, t)  → InstallManifest      re-runs security guards; performs writes
installPlugin(...)                                       orchestration
upgradePlugin(...)                                       hash check → orchestration → prune → audit
```

`buildPluginPlan` absorbs everything `applyPlugin` does today except the writes:
commit resolution, `ghTree`, `plugin.json` and `.mcp.json` parsing,
`parseManifestMcp`, `extractServers`, `detectAuthKind`, `selectPluginFiles`, the
`ignored` tally. Decisions that are currently side effects of parsing become typed
plan fields: `needsSecret`, `runsThirdPartyCode`, and the notes that today are pushed
onto `manifest.notes` from inside `routeServer`.

`InstallManifest` remains the output shape of `applyPlanResources`, so the plugins UI,
audit and `pruneRemoved` keep working — the manifest becomes a projection of the plan
rather than a separate truth.

`PluginReview` **replaces** `UpgradePreview`, whose `touchesConnectors` becomes a
derived warning. Shipping both would mean two previews making different promises.

### Preflight needs a typed error

`assertSafeUrl` currently throws a bare `Error`, and its four cases differ only by
message text — user-facing, deliberately friendly copy. Classifying on that text
would let a copy edit silently flip a security verdict. So `net/ssrf.ts` gains:

```ts
type UnsafeUrlReason = "blocked" | "unresolved" | "invalid";
class UnsafeUrlError extends Error { readonly reason: UnsafeUrlReason }
```

Messages are unchanged, so the existing catch in `mcp/service.ts` that re-wraps
`e.message` as a `ValidationError` keeps working. `preflightUrl(url, blockPrivate)`
wraps it and returns a verdict instead of throwing. All three reasons are fail-closed.

## 6. Delta classification

```ts
InstallDelta {
  upstream:  DeltaEntry[];   // sourceBefore  → sourceAfter: what the author changed
  effective: DeltaEntry[];   // runtimeBefore → sourceAfter: what will be overwritten
  kinds: DeltaKind[];        // the SET of classes present, not an ordinal
  gate: "no_consent" | "requires_consent" | "cannot_apply";
}
```

| Kind | Rule |
|---|---|
| `unchanged` | canonical forms equal |
| `attenuation` | **provable only**: resource fully removed, or connector force-disabled |
| `expansion` | anything added: connector, query key, secret key, arg, entrypoint, `authKind` where there was none |
| `replacement` | same identity, different target: `scheme`, `host`, `port`, `pathname`, `command`, a `KEY=VALUE` arg value, `instructionHash`, `contentHash` |
| `removal` | gone entirely |
| `unknown` | baseline incomplete: legacy without `installSurface`, or the pinned commit is gone from upstream |

Any change to an *existing* resource is `replacement`. "Fewer" does not prove
"weaker": the canonical counterexample, which belongs in the test suite, is
`needsSecret: true → false` — a placeholder replaced by a hard-coded credential,
i.e. the plugin now carries its own key to someone else's service. That is strictly
worse and classifies as `replacement`.

Gate mapping:

```
no_consent:       unchanged, removal, proven attenuation
requires_consent: expansion, replacement, unknown
cannot_apply:     any preflight blocked | invalid | unresolved
```

The gate reads `effective`. `upstream` is surfaced only when the two differ.

Rename needs no special case: it is `removal` + `expansion`, so the expansion half
gates it. Provable rename is therefore unnecessary for *safety* — `originKey` is the
manifest path plus the server key, and the server name **is** that key, so a rename
changes it. Manual linking exists only to move a policy, never to decide the gate,
and similarity of URL or config is a hint, never proof.

### Policy dispositions

Policies are keyed `(capabilityType, capabilityKey)` where the key is the resource
**name**; `run-context.ts` asks `policy.effect("connector", name)` and knows nothing
about `source`. So a removal does not orphan a policy by itself:

- another resource of that name exists → "this policy will continue to apply to *X*";
- none exists → "this policy applies to nothing right now; if a resource with this
  name appears later, it will apply to that".

`PolicyDisposition = "keep" | "delete" | "reassign"` is part of `reviewHash` and is
applied inside the same operation, logged with the existing `policy.set` /
`policy.clear` actions carrying `operationId`. Otherwise the installer consents to one
policy outcome and apply performs another.

## 7. Claim, lease, fence

### First-install claim needs a database guarantee

`pluginInstalls` has only non-unique indexes today, so two parallel first installs
both pass the existence check and both insert with different ids — the code's
"idempotent per (marketplace, plugin, owner)" claim holds only without concurrency.
Two **partial** unique indexes (partial because `user_id IS NULL` for system scope,
and `NULL != NULL` in a plain unique index):

```sql
UNIQUE (marketplace_id, plugin_name, scope) WHERE user_id IS NULL
UNIQUE (marketplace_id, plugin_name, scope, user_id) WHERE user_id IS NOT NULL
```

The staging insert then *is* the first-install claim: one wins, the other gets a
conflict and re-reads the operation in flight.

### Operation-owned transitions

```
claim:       WHERE committedRevision = expected AND (applyState IS NULL OR status = 'failed')
finalize:    WHERE applyState.operationId = ours AND status = 'applying' AND lease valid
mark failed: same operationId + applying
```

A local phase decides what a `catch` may do:

| Phase | A failure means | Allowed transition |
|---|---|---|
| `unclaimed` | nothing changed | none, audit only |
| `claimed` | second hash check failed, no writes yet | release claim, outcome `stale` |
| `mutating` | resources were already changed | → `failed` |
| `committed` | only the audit write failed | none; the install succeeded |

A blanket `catch → failed` would mark a failure where nothing happened and, worse,
where everything had already succeeded.

### Lease

`startedAt` alone lets the reconciler kill a long but healthy install. The
`applying` state carries `leaseExpiresAt`; apply renews it by CAS on its own
`operationId`; every resource write requires a valid lease; the reconciler flips
`applying → failed` only on an expired lease; renewal and reaper race through the same
CAS, and if the reaper wins the worker can no longer mutate or finalize.

This is the task queue's mechanism (`LEASE_SECONDS`, `heartbeat` CAS on
`(id, status, worker_id)`, `reconcileZombies` on expiry), reused rather than
reinvented.

### Mutation fence

The fence is a predicate **inside** the mutating statement, so there is no gap
between checking and writing. Authority is explicit:

```ts
type MutationAuthority =
  | { kind: "manual" }
  | { kind: "plugin-apply"; operationId: string };
```

- **manual** — allowed when the owning install is not `applying`;
- **plugin-apply** — allowed only when `status = 'applying'`, `operationId` is ours,
  and the lease is still valid.

The two must be different predicates. A single "is anyone applying?" test has an
inverted hole: once the reconciler sets `failed`, a dispossessed worker finds no
`applying` row and proceeds. Under the rule above, an apply-path write after
`failed`, after finalize, or after losing the lease always returns `fenced`.

Install identity is derived from the row's own `source`, not from a caller-supplied
id, so a wrong id cannot bypass the fence:

```sql
AND NOT EXISTS (
  SELECT 1 FROM plugin_installs pi
  WHERE mcp_servers.source = 'catalog:' || pi.id
    AND pi.manifest #>> '{applyState,status}' = 'applying'
    AND pi.manifest #>> '{applyState,operationId}' IS DISTINCT FROM $operation_id
)
```

For a plugin-owned **insert** the rule is stricter: the install must exist and its
applying `operationId` must equal ours. That also makes new orphans impossible.

The fence applies to connector update/insert/delete/enable, skill
ingest/delete/enable, `persistPluginFiles`, and `pruneRemoved`. Every conditional
write reports its result as `updated | missing | fenced` — never a boolean, and never
a silent success on zero rows. For idempotent prune, `missing` is a success;
`fenced` is always a conflict.

The guarantee is exact against the application's own write paths. A multi-statement
manual edit needs the predicate on each statement, and its worst case is a refusal
part-way through — a refusal, not corruption. Direct SQL by an operator is outside
any design's reach.

### Apply barrier

```
preview: build → observe → baselines → review

apply:
  validate request/authority
  reject if no reviewHash          — before any DB access
  rebuild plan + fresh observations + both baselines
  compare accepted hash            → stale  → audit(stale) + 409 with the fresh review
  gate === cannot_apply            → audit(blocked) + refuse
  tx: CAS claim + append pending audit
  re-read runtime baseline + SECOND hash check
  apply resources → files → prune  (lease renewed throughout)
  tx: finalize committed view + append succeeded audit
catch (phase-dependent):
  tx: mark failed (operationId = ours) + append failed audit
```

A valid hash does not override `cannot_apply`: DNS may have turned unsafe after the
review, which is not a different consent but an inability to proceed. The 409 carries
the fresh review in its body to save a round trip — it does not close the new window,
which is why the next apply rebuilds everything again.

`installPlugin` and `upgradePlugin` are orchestration boundaries, **not** database
transaction boundaries: the services write through the global `db` handle, so resource
writes do not compose into one transaction. Atomicity is scoped to what needs it — a
state transition together with its journal entry. Making the writers accept `tx` is a
separate change; until then, every fetch and probe must happen before a transaction
opens.

### Caching

The artifact half of a plan is immutable by construction: `targetSha` is a
content address, so the tree at that SHA is the same bytes forever, and a force-push
can only make it unreachable. Cache key:
`owner/repo/subdir/sha/canonicalOnly/parserVersion`. The cache holds raw secrets, so
it is bounded, process-local, never logged and never serialized. `sourceBefore` is
immutable too and may be cached. Never cached: `runtimeBefore`, observations, and the
SHA reachability check — those are exactly what changes between preview and apply. A
404 on a previously reachable SHA is `cannot_apply`.

## 8. Runtime committed view

The fence protects writers; readers still need protecting from intermediate state.
`listEnabledServerConfigs` and `listAvailableSkills` filter only on scope and
`enabled`, with no join to the owning install, so mid-apply the agent could see a
half-updated set, a connector that is not finalized, or the resources of a failed
install.

A fourth filter joins the existing chain (scope → enabled → muted → **owner ready**),
mirroring how `mutedIds` already layers per-user opt-out on top of the row query:

| Row | Visible to runtime |
|---|---|
| `source` not `catalog:*` | yes |
| `catalog:<id>`, install ready | yes |
| `catalog:<id>`, `applying` or `failed` | no |
| `catalog:<id>`, owner row missing | no (fail-closed) |

`enabled` is never touched, so a user's own choice survives. Applies to
`listEnabledServerConfigs`, `listAvailableSkills` and any background warm/health path
that can activate a connector. `getSkillForRun` goes through `listAvailableSkills`, so
it inherits the filter — a direct test pins that.

Finalize becomes the publication moment. This also neutralizes today's `catalog:`
orphans at runtime while leaving them visible in Connections for manual cleanup.

**Temporal boundary:** the claim affects *new* runs. A run already in flight finishes
with the tool snapshot it resolved, as everywhere else in this codebase; instant
revocation would need a registry of live MCP connections and is not in scope.

## 9. User interface

Not a new screen: a panel in the existing install flow and in the upgrade review that
`PluginReview` replaces.

**Two registers from one source.** The plain text is generated from the same
`DeltaEntry` list as the technical view, never written separately, so the two cannot
drift. The expander goes to the authorized installer — system scope to an admin,
personal scope to its owner. Only org policies and org-wide summaries stay admin-only.

The words *capability*, *manifest* and *surface* do not appear in user-facing copy.

**Endpoint display** is exactly `scheme + host + effective port + path + query key
names` — no values, no URL credentials, no fingerprints, even in the ephemeral
response, so it cannot become a loophole. `cannot_apply` shows the same redacted form.

`command` and `args` are the exception, and only in the ephemeral response to the
authorized installer: they are the object of the review, and redacting *what code
runs* would make the review pointless. The durable projection carries their execution
shape and a fingerprint instead. The two rules do not conflict because they cover
different fields — an endpoint is a destination, a command is the subject.

**Unconditional stdio block**, above the list rather than as a diff row, for any
stdio connector:

> Цей плагін запускає власну програму в пісочниці. Під час використання вона матиме
> доступ до робочих і спільних файлів, відкритих для цієї пісочниці.
>
> Доступ до інтернету залежить від налаштувань проєкту, в якому запускається плагін.

No project list: it goes stale, and a personal owner has no business seeing org
project names. The effective network mode is shown only when there is a concrete
project context.

**Axes.** `effective` by default; `upstream` appears only when they differ — that is,
on local modification or an unfinished apply.

**States.**

- first install `applying` → a separate "Встановлюється" card;
- upgrade `applying` → the plugin stays in place, marked "Оновлюється";
- `failed` → a "Потребує уваги" section with **"Переглянути й повторити"** (not
  "Повторити": §7 requires a fresh plan, observations, baselines and hash) and
  "Видалити", which cleans the staging row, partial `catalog:<id>` resources, files
  and operation state;
- resources of a non-ready install are shown as unavailable, not as deleted.

Three distinct conditions must never be conflated in copy: `applyState: failed` is a
known unfinished apply; runtime drift is a measured difference; *locally modified* is
only claimed when the change is attributable to an operator.

## 10. Audit

Operation events are separate `AuditAction` values, so an outcome is visible and
filterable from the activity list rather than only after expanding a row:

```
plugin.apply_accepted    (outcome=pending, carries the full DurablePluginReview)
plugin.apply_succeeded
plugin.apply_stale
plugin.apply_blocked
plugin.apply_failed
```

Terminal events carry only `{ operationId, reviewHash, outcome, errorCode? }` — the
full review is stored once, in `accepted`.

Events are idempotent: the id is deterministic
(`plugin-apply:<operationId>:accepted|succeeded|stale|blocked|failed`) and the insert
uses `ON CONFLICT (id) DO NOTHING`. `auditLog.id` is already a text primary key, so no
schema change is needed. Two reconcilers, or one that runs twice, cannot duplicate a
terminal event.

The lifecycle events use `insertPluginAudit`, which takes a `tx` and **throws** —
the existing `audit()` swallows its own failure, so it cannot provide the `pending`
record the reconciler completes. `audit()` stays for less critical events.

Not audited: opening or dismissing a preview. Closing a dialog is not a decision, and
a record per preview would make the trail unreadable where it must be legible.

Adding these actions forces their localization: `AUDIT_ACTIONS` has a compile-time
completeness check and `audit-i18n.test.ts` fails if an action has no localized
string.

The reconciler never resumes an `applying` operation — the executable plan may have
existed only in memory and the observations have moved. It transitions to `failed`,
appends the terminal event, and requires a fresh review. This matches the queue's
existing stance: a lost lease fails a task, and nothing is ever requeued.

## 11. Migration

The partial unique indexes will fail to create if duplicates already exist, and
migrations run automatically at boot (`instrumentation.ts` → `runMigrations()`), so a
bare `CREATE UNIQUE INDEX` would leave an upgraded instance refusing to start.

The migration therefore pre-checks:

```sql
SELECT marketplace_id, plugin_name, scope, user_id, count(*)
  FROM plugin_installs GROUP BY 1,2,3,4 HAVING count(*) > 1
```

and on a hit stops with the offending rows named in the error and the required action
stated: the merge is manual, because each duplicate may own a distinct set of
`catalog:<id>` resources. Nothing is deleted automatically. The `CHANGELOG` entry
names this operator action.

## 12. Testing and acceptance

| Group | Proves | Needs Postgres |
|---|---|---|
| Characterization of `buildPluginPlan` | the refactor is behaviour-neutral: inline/referenced/root precedence, placeholder headers/env, stdio bundled/unbundled, `only`, duplicate names, malformed manifest, auth-probe failure, caps/truncation, rename | no |
| Canonicalization and hash | order independence, length-prefixing (`"a"+"bc"` ≠ `"ab"+"c"`), domain separation, field path in the fingerprint, and that timestamps, notes, localized strings and resolved IPs are absent | no |
| Delta table | all six kinds plus `needsSecret: true→false`, `https→http`, `/read→/admin`, port change, a same-size file swap, and a rewritten `SKILL.md` | no |
| Redaction | no values in the public or durable projection, no `contentHash` in public, no URL credentials; a compile-time test that `insertPluginAudit` rejects `ReviewResponse` | no (tsc) |
| Phase machine | which transition each of `unclaimed / claimed / mutating / committed` permits | no |
| SSRF | typed `blocked / unresolved / invalid`; the build preflight replaces neither the upsert nor the connect guard; public→public DNS rotation needs no fresh consent; public→private blocks apply | no |
| Apply gate | missing hash refused before any DB access, and a valid hash does not bypass `cannot_apply` (unit); stale before the claim, and stale after the claim releasing it with no resource writes (Postgres) | **yes**, in part |
| Replay | the hash is bound to operation kind, install id, marketplace and plugin, scope, owner, target SHA and `only`, so a review accepted for one install cannot be replayed against another | no |
| First-install claim | two parallel installs, one conflict | **yes** |
| Operation-owned transitions | a foreign `operationId` can neither finalize nor mark failed | **yes** |
| Fence | our own operation passes, a foreign one is `fenced`; `missing` ≠ `fenced`; an apply-path write after `failed` or after lease loss is `fenced` | **yes** |
| Lease | a valid lease is untouched; an expired one is taken by exactly one of two reconcilers; a worker cannot write or finalize after the reaper won; a renewal that wins the race protects the operation | **yes** |
| Runtime committed view | `applying` / `failed` / owner-missing invisible to `listEnabledServerConfigs`, `listAvailableSkills` and `getSkillForRun`; visible to `listServers` | **yes** |
| Audit atomicity | a failed pending insert rolls back the claim; a failed terminal insert rolls back its state transition; a repeated reconciler does not duplicate an event | **yes** |
| Migration pre-flight | duplicates stop the migration with an actionable message; nothing is auto-deleted | **yes** |
| Orphan prevention | a `catalog:` insert without a staging owner and a valid operation lease is rejected | **yes** |
| Policy dispositions | the same-name analysis and the hash coverage (unit); applying a disposition inside the operation and its audit events (Postgres) | **yes**, in part |
| UI | a personal owner sees the technical detail; first-install and upgrade `applying` render differently; `failed` offers "Переглянути й повторити"; the endpoint stays redacted | no |

Ten groups touch Postgres — eight entirely, two in part. Their subject is an SQL
predicate, which mocks cannot prove. That is an acceptance condition, not a
preference.

## 12a. Phasing

The scope above is more than one implementation plan. Four phases, each independently
shippable and each leaving the tree green:

**A — The seam.** `buildPluginPlan` / `applyPlanResources`, plus the characterization
fixtures that prove the split is behaviour-neutral. No user-visible change. Unblocks
everything else, and is the only phase that touches the existing install path
wholesale.

**B — Surface, delta, review.** The three projections, canonicalization, fingerprints,
delta classification, the typed `UnsafeUrlError` and `preflightUrl`, the versioned
stored manifest and its central reader. Computed and stored; nothing is gated yet, so
still no user-visible change.

**C — Serialization.** Partial unique indexes with the migration pre-flight, the
staging row, claim, lease, fence, `updated | missing | fenced`, the runtime committed
view, the reconciler. This is where concurrent installs become correct. Operator-
visible (the migration may halt), still no consent gate.

**D — The gate and the screen.** The apply barrier with both hash checks, the audit
events and their localization, policy dispositions, and the UI. This is the phase that
delivers the feature.

Phase A must land alone: a refactor of the largest function in `install.ts` mixed with
new behaviour would make a regression impossible to attribute.

## 13. Conditions for future work

Recorded so the boundaries of this design stay legible:

- **Transactional writers.** Passing `tx` into the resource writers would let the
  fence become a lock instead of a per-statement predicate.
- **Provable rename.** Requires a stable id in the plugin manifest, ours or upstream.
- **Enforced capabilities.** Requires isolation per plugin, i.e. a container per
  plugin rather than per session. Only then does `attenuation` gain a meaning beyond
  full removal.
- **Instant revocation** for runs already in flight requires a registry of live MCP
  connections.
