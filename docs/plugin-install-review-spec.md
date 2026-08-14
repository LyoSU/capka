# Plugin install review — design

**Date:** 2026-08-13
**Status:** implemented — all four phases, then hardened after an audit found the gate was
neither mandatory nor authorized. See "What shipped" and "What the audit found" at the end of
§12a.

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

   There is exactly **one** carve-out, and it is narrow enough to state in full: the
   ephemeral `EphemeralExecutionDetail` carries a literal `command` and `args` to the
   authorized installer in one response. It is never persisted, never audited, and
   never reaches a non-installer, and the type boundary — `insertPluginAudit` accepts
   only `DurablePluginReview` — makes the persistence half unrepresentable rather than
   merely forbidden. The reason is that a command line is the *subject* of the review;
   redacting it would leave the installer consenting to something they cannot read.
   Nothing else may claim this exception.
3. **No change to product, install or resource state happens before the claim is
   won.** Append-only audit of a *refusal* (`stale`, `blocked`) is permitted before
   the claim and is the only exception — a refusal that left no trace would hide
   exactly the attempts worth seeing.
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
/** Parameterized, not a union of element types: `connectors: (Stored | Public)[]`
 *  would let a stored element carrying fingerprints sit inside a public surface, so
 *  the leak would still be representable. */
interface InstallSurface<C, S, F> {
  schemaVersion: number;
  completeness: "derived" | "reconstructed" | "unknown";
  connectors: C[];        // sorted by originKey
  skills: S[];            // sorted by name
  files: F;
}

type StoredInstallSurface = InstallSurface<StoredSurfaceConnector, StoredSurfaceSkill, StoredSurfaceFiles>;
type PublicInstallSurface = InstallSurface<PublicSurfaceConnector, PublicSurfaceSkill, PublicSurfaceFiles>;

/** What every projection shares. Contains no value of any kind. */
SurfaceConnectorBase {
  name: string;
  originKey: string;                // manifest path + server key; valid WITHIN one commit
  transport: "http" | "sse" | "stdio";
  endpoint?: { scheme: string; host: string; port: number; pathname: string; queryKeys: string[] };
  /** The APPLIED value — what `upsertServer` writes to the row — so it belongs to the
   *  surface even though its source is an observation (`detectedAuth`). The two are
   *  not duplicates: `detectedAuth` is what the probe saw at review time, this is what
   *  the install would persist. A difference here is a `replacement`: a connector that
   *  now wants OAuth is a real change for the user regardless of whether the plugin or
   *  the remote server caused it. A difference appearing between preview and apply is
   *  an observation change and takes the 409 path instead. */
  authKind?: "token" | "oauth";
  secretKeys: string[];             // header / env NAMES only
  needsSecret: boolean;
  runsThirdPartyCode: boolean;      // always true for stdio
  bundled: boolean;
  /**
   * What this side says about activation, and the two sides say different KINDS of
   * thing — which is why one shared `enabled: boolean` would be wrong.
   *
   * An artifact surface (`sourceBefore` / `sourceAfter`) can only ever say
   * `forced_disabled` or `left_as_is`: `upsertServer`'s update path does not touch
   * `enabled`, so an install never forces a connector ON. It forces OFF exactly when a
   * `${...}` placeholder is present (`setEnabled(id, false)` in `applyPlugin`).
   *
   * A runtime surface (`runtimeBefore`) reports the row's actual state, `enabled` or
   * `disabled`, which is whatever the user or admin last chose.
   */
  activation: "forced_disabled" | "left_as_is" | "enabled" | "disabled";
}

/** Persisted. The execution shape, never the command line itself: enough to detect a
 *  change, not enough to leak what was in it. */
StoredSurfaceConnector = SurfaceConnectorBase & {
  readonly projection: "stored";
  execution?: {
    binary: string;                 // argv[0] only — "npx", "node", or a plugin-root path
    argCount: number;
    placeholderArgs: number[];      // indices carrying ${...}
    fingerprint: string;            // keyed HMAC over the full canonical command line
  };
}

/** Client-facing. Same minus the fingerprint: a keyed digest still confirms a guess
 *  about a private plugin's contents, so it stays server-side. */
PublicSurfaceConnector = SurfaceConnectorBase & {
  readonly projection: "public";
  execution?: { binary: string; argCount: number; placeholderArgs: number[] };
  changed?: ("credential" | "command" | "endpoint" | "instructions")[];
}

/** Ephemeral only, and only to the authorized installer. The single place a literal
 *  command line exists outside `ResolvedPluginPlan`. Never persisted, never audited —
 *  `insertPluginAudit` cannot accept it (§4, type boundary). */
EphemeralExecutionDetail { connectorName: string; command: string; args: string[] }

/** Skills and files split the same way as connectors — a hash is a confirmation
 *  oracle, so it stays server-side even though it is not a secret. */
StoredSurfaceSkill { readonly projection: "stored"; name: string; originPath: string; instructionHash: string; filesRootHash: string }
PublicSurfaceSkill { readonly projection: "public"; name: string; originPath: string; changed?: ("instructions" | "files")[] }

StoredSurfaceFile  { path: string; bytes: number; contentHash: string }
StoredSurfaceFiles { readonly projection: "stored"; count: number; bytes: number; rootHash: string; entrypoints: string[]; files: StoredSurfaceFile[] }
PublicSurfaceFiles { readonly projection: "public"; count: number; bytes: number; entrypoints: string[]; changedPaths?: string[]; addedPaths?: string[]; removedPaths?: string[] }
```

The generic alone is necessary but not sufficient. TypeScript is structurally typed,
and excess-property checks only fire on fresh object literals — so
`const p: PublicSurfaceConnector = someStoredConnector` compiles, and a stored value
with its fingerprint would flow into a public slot at runtime. The literal
`projection` discriminant is what makes the two mutually unassignable in **both**
directions, which is the property being claimed. Without it the type would document
the split rather than enforce it.

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
    /** Which of the three releases applies if this claim has to be given back. The row
     *  cannot infer it at release time — a staging row and a claimed ready install look
     *  identical once `applyState` is set — so the claim records it. */
    kind: "install" | "upgrade" | "retry";
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
readStoredManifest(row): {
  inventory: InstallManifest;
  installSurface: StoredInstallSurface | null;   // null for a legacy row
  committedRevision: number;                     // 0 for a legacy row
  applyState: ApplyState | null;
}
```

Outside `install.ts` exactly one place reads this column today —
`marketplace/service.ts` (`displayName`, `notes`, `commit`) via an inline cast. Under
V2 those move under `inventory`, so without a central reader that call site would
silently render blanks. No backfill: a legacy row is upgraded lazily on its next
apply.

## 5. Function contract

```
buildPluginPlan(gh, only?)           → ResolvedPluginPlan    artifact ONLY: fetch + parse, no probes, no writes
observePluginPlan(plan, policy)      → ReviewObservations    DNS preflight + OAuth discovery
projectPluginReview(plan, obs, base) → { response, durable, storedAfter }
applyPlanResources(plan, tag, t)     → InstallManifest       re-runs security guards; performs writes
installPlugin(...)                                          orchestration
upgradePlugin(...)                                          hash check → orchestration → prune → audit
```

`buildPluginPlan` and `observePluginPlan` are separate because their determinism
differs, and mixing them is what would let a stale DNS verdict masquerade as an
artifact property (§4). A plan for a fixed SHA is reproducible and cacheable; an
observation is a fact about the world at one moment and is recomputed on every apply.

`buildPluginPlan` absorbs everything `applyPlugin` does today except the writes **and
except the probes**: commit resolution, `ghTree`, `plugin.json` and `.mcp.json`
parsing, `parseManifestMcp`, `extractServers`, `selectPluginFiles`, the `ignored`
tally. Decisions that are currently side effects of parsing become typed plan fields:
`needsSecret`, `runsThirdPartyCode`, and the notes that today are pushed onto
`manifest.notes` from inside `routeServer`.

`detectAuthKind` and `preflightUrl` go to `observePluginPlan`, not here. Today
`detectAuthKind` runs inside the parse loop in `applyPlugin`, which is precisely what
makes a plan built twice for the same SHA produce two different results — the property
the split exists to remove. Anything reachable over the network belongs to
observations, wherever it sits today.

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

The classes partition by **identity**, so no change falls into two of them:

| Kind | Rule |
|---|---|
| `unchanged` | the resource's canonical form is byte-identical |
| `removal` | the resource is gone from the new surface |
| `expansion` | a resource exists that did not before |
| `attenuation` | **only** `runtimeBefore.activation = "enabled"` together with `sourceAfter.activation = "forced_disabled"`, on a resource whose canonical form is otherwise byte-identical |
| `replacement` | any other difference in a resource that exists on both sides |
| `unknown` | the baseline cannot be established: legacy without `installSurface`, or the pinned commit is gone from upstream |

The earlier formulation listed a removed resource under both `attenuation` and
`removal`, and called an added argument `expansion` while also declaring every change
to an existing resource a `replacement`. Keying on identity removes the overlap: what
changed about a resource that still exists is always `replacement`, and `expansion` is
reserved for a resource appearing.

`needsSecret: true → false` is therefore `replacement`, and the reason matters. It is
**not** "strictly worse" — it may equally mean the plugin dropped a feature that
needed the key. It is *ambiguous*, and ambiguity is exactly what must not be waved
through as a reduction. This case belongs in the test suite as the guard against
reading "fewer" as "weaker".

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

The apply-state fence does not cover a policy edit: the policy tables are not
plugin-owned, so an admin editing one by hand is not refused while an install applies.
The resolution is not a new fence but a wider baseline — **the policy rows for every
key a disposition touches are part of `runtimeBefore`**, and therefore part of
`reviewHash`.

A concurrent policy change is then not a special case at all: it is a stale baseline,
detected by the second hash check like any other, before a single resource is written.
The operation returns `stale` with a 409, the installer re-reviews against the policy
as it now stands, and nothing partial happens.

An earlier draft had the disposition skipped while the operation still finalized,
recording `policy_disposition_skipped`. That is discarded: it applied the resource half
of a decision and dropped the policy half, so what executed was not what the installer
consented to — a direct violation of invariant 6. There is no version of "succeeded"
that is honest when part of the consented change did not happen.

The conditional write stays as a belt inside the finalizing transaction, and it is a
**revision** CAS rather than a field-by-field comparison:

```sql
DELETE FROM capability_policies WHERE id = $1 AND revision = $2
```

A field list would have to be exhaustive to be safe — the policy's identity is
`(scope, capabilityType, capabilityKey, userId, projectId)` plus `effect`, with two
nullable owner columns needing null-safe comparison — and any field omitted is a hole:
a concurrent change to `capabilityType`, `userId` or `projectId` would slip past a
predicate checking only `effect`, `scope` and `capabilityKey`, deleting a policy that is
no longer the one the review analysed. One token covers every column at once and cannot
be under-specified.

That token cannot be `updated_at`, even though the column already exists. `setPolicy`
writes it as `new Date()`, i.e. millisecond precision with no monotonicity guarantee, so
two updates inside one millisecond produce an identical value and the CAS sees no
change. Moving it to a database default would be **worse**: `now()` is transaction-start
time, so two updates in one transaction would be identical by construction.

So the migration that adds the partial unique indexes also adds:

```sql
ALTER TABLE capability_policies ADD COLUMN revision bigint NOT NULL DEFAULT 0
```

and `setPolicy` increments it in the same `onConflictDoUpdate.set` that writes `effect`.
There is exactly one place to do this: the module owns both write paths — `setPolicy`
(upsert) and `clearPolicy` (delete, which needs no increment because the row goes) — so
the "a writer forgot to bump it" failure has a single possible site, inside the module
that owns the table. `updated_at` stays for display; it is simply not the CAS token.

An explicit counter is preferred over `xmin` because it is testable and stable as a
long-term contract rather than an implementation detail of the storage engine.

Its zero-row case means the row moved between the second hash check and the write — a
window the fence does not cover — and that aborts the transaction rather than skipping
the disposition. The operation becomes `failed`, which is legible, instead of
`succeeded`, which would be a lie.

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
| `unclaimed` | nothing changed | none; append the refusal event only |
| `claimed` | the second hash check failed, no resource writes yet | release the claim (see below), outcome `stale` |
| `mutating` | resources were already changed | → `failed` |
| `committed` | nothing can fail here | none |

**Releasing a claim is not one operation.** What "release" means depends on how the
row got there, and conflating them either strands a staging row or destroys a prior
state:

| `applyState.kind` | Release restores |
|---|---|
| `install` | delete the staging row — there is no committed state to return to |
| `upgrade` | clear `applyState`, leaving the committed view untouched |
| `retry` | restore `status = 'failed'`, not `NULL` — the earlier failure is still true and must stay visible |

There is no "committed but the audit failed" phase: finalize and its `succeeded` event
are one transaction, so either both landed or neither did. If neither did, the phase
is still `mutating` and the operation is `failed`.

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

The two predicates are **different SQL**, not one with a parameter. Copying only the
first into an apply path is the mistake this section exists to prevent.

`{ kind: "manual" }` — refuse while anyone is applying:

```sql
AND NOT EXISTS (
  SELECT 1 FROM plugin_installs pi
  WHERE mcp_servers.source = 'catalog:' || pi.id
    AND pi.manifest #>> '{applyState,status}' = 'applying'
)
```

`{ kind: "plugin-apply", operationId }` — proceed only while the row is still ours and
the lease is alive:

```sql
AND EXISTS (
  SELECT 1 FROM plugin_installs pi
  WHERE mcp_servers.source = 'catalog:' || pi.id
    AND pi.manifest #>> '{applyState,status}' = 'applying'
    AND pi.manifest #>> '{applyState,operationId}' = $operation_id
    AND (pi.manifest #>> '{applyState,leaseExpiresAt}')::timestamptz > now()
)
```

`NOT EXISTS(... IS DISTINCT FROM ...)` satisfies neither: it lets a dispossessed
worker through once the reconciler has set `failed`, because then no `applying` row
exists at all.

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
  reject if reviewHash is absent or malformed   — SYNTACTIC, before any DB access
  validate request + authority                  — needs the DB, so it comes second
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

The management API must expose which of these a resource is in —
`ready | applying | failed | orphaned` per resource, not just per install — or the UI
cannot distinguish "temporarily unavailable" from "gone", and a user staring at a
connector that no longer answers has no way to learn why. `orphaned` is the
owner-missing case: visible, unusable by the agent, removable by hand.

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

`DO NOTHING` alone would also silently swallow a *different* payload written under the
same id — two writers disagreeing about the outcome would leave whichever arrived
first, with no signal. So the insert returns whether it inserted, and on a conflict the
existing row's `{ outcome, reviewHash }` is compared:

```
same id + same payload      → idempotent success
same id + different payload → throw InvariantViolation
```

It must **throw**, not log. `insertPluginAudit` runs inside the same transaction as the
state transition it records, so throwing rolls that transition back; merely logging
would let the transaction commit while the journal asserts a different outcome — the
state and its record disagreeing permanently, with only a warning line to show for it.
Two reconcilers writing the same terminal event are the idempotent case; two writing
different ones are a bug that must stop the write it belongs to.

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

The same migration adds `capability_policies.revision` (§6). Both changes share one
migration so an instance can never run with the indexes but without the revision column,
which would leave the policy CAS silently matching everything.

The migration therefore pre-checks:

```sql
SELECT marketplace_id, plugin_name, scope, user_id, count(*), array_agg(id) AS install_ids
  FROM plugin_installs GROUP BY 1,2,3,4 HAVING count(*) > 1
```

`array_agg(id)` is not decoration: the error promises to name the offending rows, and
a bare `count(*)` could not. Each id is what the operator needs to inspect the
`catalog:<id>` resources before merging. On a hit the migration stops with those ids in
the message and the required action stated: the merge is manual, because each duplicate may own a distinct set of
`catalog:<id>` resources. Nothing is deleted automatically. The `CHANGELOG` entry
names this operator action.

## 12. Testing and acceptance

| Group | Proves | Needs Postgres |
|---|---|---|
| Characterization of `buildPluginPlan` | the refactor is behaviour-neutral: inline/referenced/root precedence, placeholder headers/env, stdio bundled/unbundled, `only`, duplicate names, malformed manifest, caps/truncation, rename. Also that a plan built twice for one SHA is identical — which holds only because no probe runs here | no |
| Characterization of `observePluginPlan` | auth-probe failure degrades to a verdict rather than aborting the plan (phase A); preflight failure does the same and an observation change alters `reviewHash` (phase B) | no |
| Projection typing | a `StoredSurfaceConnector` is not assignable to a `PublicSurfaceConnector` in either direction, so a fingerprint cannot reach a public surface — a compile-time test, since the discriminant is the whole mechanism | no (tsc) |
| Canonicalization and hash | order independence, length-prefixing (`"a"+"bc"` ≠ `"ab"+"c"`), domain separation, field path in the fingerprint, and that timestamps, notes, localized strings and resolved IPs are absent | no |
| Delta table | all six kinds plus `needsSecret: true→false`, `https→http`, `/read→/admin`, port change, a same-size file swap, and a rewritten `SKILL.md` | no |
| Redaction | no values in the public or durable projection, no `contentHash` in public, no URL credentials; a compile-time test that `insertPluginAudit` rejects `ReviewResponse` | no (tsc) |
| Phase machine | which transition each of `unclaimed / claimed / mutating / committed` permits | no |
| SSRF | typed `blocked / unresolved / invalid`; the build preflight replaces neither the upsert nor the connect guard; public→public DNS rotation needs no fresh consent; public→private blocks apply | no |
| Apply gate | an absent or malformed hash is refused with no DB access at all — the check is syntactic and precedes authority resolution, which itself needs the DB; and a valid hash does not bypass `cannot_apply` (unit); stale before the claim, and stale after the claim releasing it with no resource writes (Postgres) | **yes**, in part |
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
| Policy revision | two consecutive policy updates yield different `revision` values even when they land in the same millisecond — the case a timestamp cannot distinguish; a disposition carrying a stale revision affects zero rows and turns the apply into `failed` rather than skipping | **yes** |
| UI | a personal owner sees the technical detail; first-install and upgrade `applying` render differently; `failed` offers "Переглянути й повторити"; the endpoint stays redacted | no |

Ten groups touch Postgres — eight entirely, two in part. Their subject is an SQL
predicate, which mocks cannot prove. That is an acceptance condition, not a
preference.

## 12a. Phasing

The scope above is more than one implementation plan. Four phases, each independently
shippable and each leaving the tree green:

**A — The seam.** `buildPluginPlan` / `observePluginPlan` / `applyPlanResources`, plus
the characterization fixtures that prove the split is behaviour-neutral. All three:
extracting the parser without also extracting the probes would leave `detectAuthKind`
inside the parse loop, so the plan would still be non-reproducible and phase B would
have to re-cut the same function. No user-visible change. Unblocks everything else, and
is the only phase that touches the existing install path wholesale.

`observePluginPlan` arrives in A carrying **only** the `detectAuthKind` call that
`applyPlugin` already makes — relocated, not added. `preflightUrl` is new behaviour (a
DNS resolution that does not happen today) and belongs to B, along with the rest of the
observation surface. A phase that promises behaviour-neutrality cannot introduce a
network call.

**B — Surface, delta, review.** The three projections, canonicalization, fingerprints,
delta classification, the typed `UnsafeUrlError` and `preflightUrl`, the versioned
stored manifest and its central reader. Computed and stored; nothing is gated yet, so
still no user-visible change.

**C — Serialization, *including* the minimal state UI.** Partial unique indexes with
the migration pre-flight, the staging row, claim, lease, fence,
`updated | missing | fenced`, the runtime committed view, the reconciler — **and** the
per-resource `ready | applying | failed | orphaned` status rendered in the plugins and
Connections lists, with the "Потребує уваги" affordance for `failed`.

The state UI cannot wait for D. C is the phase that starts hiding `applying` and
`failed` resources from the agent; shipping that without a way to see why would leave a
user whose plugin silently stopped working with no explanation — which §9 identifies as
the worst state this feature can produce. A phase is only independently shippable if
its own failure mode is legible to the person it happens to.

**D — The gate and the screen.** The apply barrier with both hash checks, the review
screen itself with its two registers, the audit events and their localization, and
policy dispositions. This is the phase that delivers the consent gate.

Phase A must land alone: a refactor of the largest function in `install.ts` mixed with
new behaviour would make a regression impossible to attribute.

### What shipped (2026-08-14)

All four phases are implemented and on `master`. What follows records where the
implementation departs from the design above, and what is left open — both are more useful
than a checklist.

**Departures.**

- **§12a's phasing was wrong about the state UI, then right again.** It required C's state UI
  to ship with C, on the grounds that C starts hiding resources from the agent. But C alone
  does not PRODUCE `applying` or `failed` — nothing claimed until D's barrier landed — so
  through C the only hidden state was `orphaned`, which C made visible under Connectors. The
  UI shipped with the barrier, which is where the argument actually bites.
- **`runtimeBefore` is partly artifact-derived, and has to be.** §6 describes it as read from
  the rows. Some of the surface is an artifact property the row does not record: a
  placeholder connector's header NAMES are not persisted at all. Reading their absence off
  the row would report `needsSecret: true → false` on every upgrade of every such connector,
  forever — a permanent false positive that teaches the reader to ignore the screen. So the
  row supplies what it knows and the committed artifact supplies the rest, marked
  `completeness: "reconstructed"`.
- **A plugin-owned INSERT is fenced by a lock, not by a WHERE clause.** §7 puts the predicate
  inside the mutating statement. An insert has no row to read `source` from, so
  `insertFenceLock` takes `FOR NO KEY UPDATE` on the owning install inside the caller's
  transaction instead. Claim, fail, finalize and reap are all UPDATEs on that row, so each
  blocks until commit and the check cannot go stale — equivalent, by a different mechanism.
- **`reassign` is unimplemented and refuses loudly.** Moving a policy needs a target the
  review does not carry. Treating it as `keep` would apply something other than what was
  accepted, so it throws.

### What the audit found (2026-08-14, after shipping)

Recorded because the pattern matters more than the list: every one of these passed 235 green
tests. The tests exercised the mechanisms against the threats the author imagined, and none of
them tested an ATTACK.

- **The gate was optional.** Three writer paths took no `reviewHash`, so the barrier was
  bypassable by choosing an older endpoint — and the UI fell back to one of them whenever the
  review had not loaded, i.e. fail-open on exactly the request that matters. All three now
  return 410. §5's "PluginReview REPLACES UpgradePreview" was the right instruction and was not
  followed; leaving the old writer alive is what made the new one optional.
- **The gate was not authorization.** `readPolicyBaseline` returns rules of every scope by
  design (§6), and nothing stopped a personal installer from naming an org-wide rule in
  `dispositions` and deleting it — with default-allow, that is escalation. The review hash could
  not have helped: the client supplies the dispositions and the server hashes them WITH the
  request, so a forged one yields a different valid hash. **A hash proves nothing was swapped;
  it cannot prove the asker was entitled to ask.** That distinction was missing from this
  document and is now §6's `assertDispositionAllowed`.
- **The fence stopped at the parent rows.** `plugin_files` and `skill_files` — the bytes
  `plugin-runtime.ts` materializes and chmods — were written unfenced, so an apply that lost its
  lease could overwrite the executable files of a completed one. §7's "the fence applies to …
  `persistPluginFiles`" was stated and not implemented.
- **Two redactions hid real changes.** The endpoint is normalized without query values or
  userinfo and `secretKeys` holds only names, so a changed token was byte-identical: a
  stored-only `credentialFingerprint` over the raw url+headers now covers it. And
  `runtimeBefore` copied the skill hashes from the artifact, making a database-side edit
  invisible — the artifact now also records `bodyHash`, the quantity the row actually holds.
- **The commit order was wrong.** Dispositions and `succeeded` committed before `finalizeApply`,
  so a lost CAS left the policy deleted, the journal saying succeeded, and the plugin invisible.
  Finalize now runs first, inside the same transaction.

The departure worth generalizing: **"deliberately shows everything" and "may therefore change
everything" are different sentences.** Two of the five holes above are the same mistake — a
comment asserting a guarantee the code did not implement (`resolveSubject`'s scope claim,
`runtime-surface`'s false-positive argument). A comment is not an enforcement mechanism, and one
that overstates is worse than none.

**Open.**

- **`previewUpgrade`'s file diff still exists.** §5 says `PluginReview` REPLACES it; in
  practice the two render together, because the diff answers "what did the author change"
  and the review answers "what will this be able to do", and an operator wants both. If they
  ever disagree, that is the signal to finish the replacement.
- **No per-RESOURCE status in the API.** §8 asks for `ready | applying | failed | orphaned`
  per resource; `ownerStates` computes exactly that and is tested, but only the per-install
  state is surfaced to the UI. A resource-level badge in the Connectors list is the
  remaining half.
### A second audit the same day, and what it says about the first one (2026-08-14)

An independent review of the four fix commits found nine more defects, four of them P1. Two
facts about that list matter more than the list.

**One was introduced BY a fix in it.** Closing the "IPv6 literals read as unresolvable" hole
brought bracket-stripping, which woke a v6 branch that had been dead — and that branch decided
a security question by STRING PREFIX (`startsWith("::ffff:")`). So `::ffff:169.254.169.254`
was caught and `::ffff:a9fe:a9fe`, the same address in hex, was not; nor were `::7f00:1`,
`::127.0.0.1`, the NAT64 prefix, or loopback spelled `0:0:0:0:0:0:0:1`. `dns.lookup` returns a
literal UNCHANGED, so for literals the guard is the only thing that ever looks at the address.
Fail-closed code being replaced by fail-open code is the specific risk of fixing a
classification bug, and nothing in the first pass looked for it.

**Four of the nine are one shape: a second actor could reach a row, and nothing in the
statement said it had the right to.** `upgradePlugin` (deleted, not deprecated — it was an
unfenced `set({ manifest })` and `applyState` lives in that column), `installPlugin`'s
unfenced pin/manifest writes, the manual fence's `NOT EXISTS (… FOR NO KEY UPDATE)` locking
NOTHING in the only case that proceeds, and two writers claiming one terminal journal id. The
last one generalizes the P0's lesson to the journal: **winning the CAS is what authorizes the
record, exactly as it authorizes the write.** `markApplyFailed` returning false means the
reaper already owns this outcome, so there is nothing left for us to say about it.

And the shape of the UI break was worth keeping: the gate landed ahead of its callers, so
Browse → Install answered 410 rather than installing without a review. That is the survivable
direction of the mistake, and the reverse is what made the gate optional the first time.

- **`installSkillRepo` now installs skills only.** Not a product decision after all: the manage
  approval card enumerates the skills it found, so routing a `.mcp.json` connector and bundled
  plugin files off the same repo applied a strictly larger set than the human agreed to.
  Narrowing it makes the code match consent already obtained rather than imposing a new
  restriction — and `plan.notes` names the skipped connectors, so the repo is not quietly
  misrepresented either. Whether such a repo should be installable through the full review
  instead is still open, and still a product question.

### Where the line sat before that (2026-08-14, mid-session)

**A — done.** `plan.ts` / `observe.ts` / `apply.ts`, behind 17 characterization fixtures.

**B — done.** `UnsafeUrlError` + `preflightUrl` (`net/ssrf.ts`), `canonical.ts`,
`crypto.fingerprint`, `surface.ts`, `project.ts`, `delta.ts`, `manifest-store.ts` (V2 +
central reader, wired into both apply paths and `service.ts`).

**C — mechanisms done, state UI not.** Migration `0049` (partial unique indexes with the
duplicate pre-flight, `capability_policies.revision`), `operation.ts`,
`runtime-view.ts`, `fence.ts`, and the reaper in `tasks/worker.ts`. All Postgres-verified.

The state UI (`ready | applying | failed | orphaned` per resource, and the "Потребує
уваги" affordance) is NOT built, and that is not the gap §12a warned about. The argument
there — that C starts hiding resources from the agent, so it must also explain why —
assumed C also starts PRODUCING those states. It does not: nothing in a production path
calls `claimApply`, so no install can be `applying` or `failed` yet. The only state the
runtime filter currently hides is `orphaned`, which C makes visible under Connectors
precisely so it can be removed.

The UI therefore has to land in the same change as the barrier, not before it. That is a
correction to §12a's phasing, not a deferral.

**D — the pure half done, the barrier deliberately not.** `review.ts` (`reviewHash`,
`projectPluginReview`, `DurablePluginReview`) is in and tested; it is inert until
something calls it.

The barrier, the review screen, the audit events and policy dispositions must land
TOGETHER. Wiring the claim without the screen would make every install that widens access
refuse with `requires_consent` and give nobody a way to consent — which breaks installing
outright. Half a gate is worse than none.

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
