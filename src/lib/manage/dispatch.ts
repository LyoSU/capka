import { canAccess, type Registry } from "./registry";
import { manageT, loc, locValue, keyOf, type ManageT } from "./i18n";
import type { PendingStore } from "./pending";
import type { Collection, Control, ManageContext, ManageInput, ManageResult } from "./types";
import type { AuditAction } from "@/lib/governance/types";

/** The mutation an Undo will run when the user clicks it: re-`apply` the prior
 *  value. Staged server-side (never handed to the model), so the model can't
 *  trigger it. Forward changes are no longer staged — they're gated by the AI
 *  SDK's native tool approval (`needsApproval`) and applied directly by `execute`
 *  once approved; only the reverse (undo) still rides the pending store. */
export type PendingPayload = { op: "set"; controlId: string; value: string };

/** Localized display of a control's raw value (uk via i18n, else the control's
 *  own English format/raw). */
function fmt(t: ManageT, c: Control, v: string): string {
  return locValue(t, c.id, v, c.format ? c.format(v) : v);
}

/** Localized control title (uk via i18n keyed by id, else the English literal). */
function title(t: ManageT, c: Control): string {
  return loc(t, `control.${keyOf(c.id)}.title`, c.title);
}

/** Localized collection title (uk via i18n keyed by id, else the English literal). */
function collLabel(t: ManageT, coll: Collection): string {
  return loc(t, `collection.${keyOf(coll.id)}`, coll.title);
}

/** Resolve the authoritative "may THIS caller add here" — the collection's own
 *  check if it has one, else the coarse role gate. Surfaced to the model so it
 *  reads its permission as fact instead of inferring it from other settings. */
function resolveCanAdd(ctx: ManageContext, coll: Collection): Promise<boolean> {
  return coll.canAdd ? coll.canAdd(ctx) : Promise.resolve(canAccess(ctx, coll));
}

function err(code: string, summary: string): ManageResult {
  return { status: "error", render: "error", code, summary };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "The action could not be completed.";
}

/** The pending store: injected in tests, else the DB-backed one (lazy-imported so
 *  pure dispatch tests never touch a database — the same pattern as `record`). */
async function pendingStore(ctx: ManageContext): Promise<PendingStore> {
  if (ctx.pending) return ctx.pending;
  return (await import("./pending")).dbPendingStore;
}

/** Record a mutation in the tamper-evident audit trail. Best-effort (a failed
 *  audit write must NOT turn an already-applied change into an error the user
 *  sees, nor swallow the undo handle) and lazy: the governance audit (and thus the
 *  DB) is only imported when no test override is supplied, so pure dispatch tests
 *  never touch a database. `action` is typed AuditAction — the cast that let a
 *  skill change get logged as a connector change is gone. */
async function record(
  ctx: ManageContext,
  action: AuditAction,
  targetKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    if (ctx.audit) {
      await ctx.audit({ action, targetType: "manage", targetKey, detail });
      return;
    }
    const { audit } = await import("@/lib/governance/audit");
    await audit({ actorId: ctx.userId, action, targetType: "manage", targetKey, detail });
  } catch (e) {
    const { log } = await import("@/lib/log");
    log.warn("manage audit write failed", { action, targetKey, err: String(e) });
  }
}

export async function dispatch(reg: Registry, ctx: ManageContext, input: ManageInput): Promise<ManageResult> {
  switch (input.action) {
    case "capabilities":
      return capabilities(reg, ctx);
    case "list":
      return list(reg, ctx);
    case "get":
      return get(reg, ctx, input.target);
    case "set":
      return set(reg, ctx, input);
    case "add":
      return add(reg, ctx, input);
    case "remove":
      return remove(reg, ctx, input);
    case "enable":
      return toggle(reg, ctx, input.target, input.itemId, true);
    case "disable":
      return toggle(reg, ctx, input.target, input.itemId, false);
    case "debug":
      return debug(reg, ctx, input.target, input.itemId);
    case "connect":
      return connect(reg, ctx, input.target, input.itemId);
    case "edit":
      return edit(reg, ctx, input.target, input.itemId);
  }
}

function capabilities(reg: Registry, ctx: ManageContext): ManageResult {
  const t = manageT(ctx.locale);
  const groups: Record<string, { id: string; title: string; description: string }[]> = {};
  for (const c of reg.visibleTo(ctx)) {
    (groups[c.scope] ??= []).push({ id: c.id, title: title(t, c), description: c.description });
  }
  for (const coll of reg.visibleCollectionsTo(ctx)) {
    (groups.collections ??= []).push({ id: coll.id, title: collLabel(t, coll), description: coll.description });
  }
  return { status: "ok", render: "capabilities", summary: "Available management capabilities", data: groups };
}

async function list(reg: Registry, ctx: ManageContext): Promise<ManageResult> {
  // Everything returned here is ALREADY filtered to what this user may change —
  // so we deliberately do NOT expose requiredRole/risk/scope, which only tempt a
  // weak model into refusing itself ("this is admin-only, so I can't"). If it's
  // in the list, the user can change it; permission is decided by the action's
  // result, not by the model reading a label.
  const t = manageT(ctx.locale);
  const items = await Promise.all(
    reg.visibleTo(ctx).map(async (c) => ({
      id: c.id,
      title: title(t, c),
      description: c.description,
      current: fmt(t, c, await c.read(ctx)),
    })),
  );
  const collections = await Promise.all(
    reg.visibleCollectionsTo(ctx).map(async (c) => ({
      id: c.id,
      title: collLabel(t, c),
      description: c.description,
      canAdd: await resolveCanAdd(ctx, c),
    })),
  );
  return { status: "ok", render: "list", summary: `${items.length} settings, ${collections.length} collections`, data: { settings: items, collections } };
}

/** The fixed set of values a control accepts, if any — a `z.enum`'s options come
 *  free off the schema; a refined string (e.g. locale) declares them explicitly. */
function controlOptions(c: Control): string[] | undefined {
  if (c.options?.length) return c.options;
  const s = c.schema as { options?: unknown };
  return Array.isArray(s.options) ? (s.options as string[]) : undefined;
}

async function get(reg: Registry, ctx: ManageContext, target: string): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const c = reg.get(target);
  if (c && canAccess(ctx, c)) {
    const v = await c.read(ctx);
    // A bounded control (enum / declared options) renders as a chip picker so the
    // user can switch with one tap; picking a chip asks the agent to `set` it, so
    // the confirm barrier still gates risky changes. Free-form controls stay a
    // plain value (shown in the activity rail, not a card).
    const opts = controlOptions(c);
    if (opts) {
      return {
        status: "ok",
        render: "choice",
        summary: `${title(t, c)}: ${fmt(t, c, v)}`,
        data: { id: c.id, title: title(t, c), value: v, options: opts.map((o) => ({ value: o, label: fmt(t, c, o) })) },
      };
    }
    return {
      status: "ok",
      render: "value",
      summary: `${title(t, c)}: ${fmt(t, c, v)}`,
      data: { id: c.id, title: title(t, c), value: v, display: fmt(t, c, v) },
    };
  }
  const coll = reg.collection(target);
  if (coll && canAccess(ctx, coll)) {
    const [items, canAdd] = await Promise.all([coll.list(ctx), resolveCanAdd(ctx, coll)]);
    return {
      status: "ok",
      render: "collection",
      summary: `${collLabel(t, coll)}: ${items.length}${canAdd ? " (you can add here)" : ""}`,
      data: { collectionId: coll.id, title: collLabel(t, coll), items, canAdd, settingsPath: coll.settingsPath, usage: coll.usage },
    };
  }
  return err("not_found", `No setting "${target}".`);
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Org autonomy mode: `autonomous` applies risky changes directly (conversational,
 *  no confirm card); `supervised` (default) shows the confirm card. Read through the
 *  registry so it's stubbable in tests and absent → supervised (safe default).
 *  Autonomy only ever covers *personal* changes: platform-wide (`org`) settings, the
 *  master switch, and connector installs always stay confirm-gated (see `set`/`add`). */
async function autonomous(reg: Registry, ctx: ManageContext): Promise<boolean> {
  const c = reg.get("org.agent_autonomy");
  if (!c) return false;
  try { return (await c.read(ctx)) === "autonomous"; } catch { return false; }
}

async function set(
  reg: Registry,
  ctx: ManageContext,
  input: Extract<ManageInput, { action: "set" }>,
): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const c = reg.get(input.target);
  // A non-admin can't even learn an admin control exists — same answer as a typo.
  // canAccess is the role gate (admin controls need isAdmin), so there's no
  // separate "forbidden" branch: a non-admin hitting an admin control already
  // gets not_found above.
  if (!c || !canAccess(ctx, c)) return err("not_found", `No setting "${input.target}".`);

  const parsed = c.schema.safeParse(input.value);
  if (!parsed.success) {
    return err("invalid_value", parsed.error.issues[0]?.message ?? "Invalid value.");
  }
  // By the time `execute` calls dispatch, the AI SDK's native tool approval has
  // already gated a risky change (see `requiresApproval` + the tool's
  // `needsApproval`): either it needed no approval (a personal/safe change, or
  // autonomous mode) or the user already approved it. So we apply directly here —
  // through the SAME server apply path an undo takes, so the two can't diverge
  // (records the audit line and stages the undo identically). `t` unused now.
  void t;
  return applySet(reg, ctx, c.id, parsed.data);
}

/**
 * Does this action require the user's approval before it runs? Consulted by the
 * `manage` tool's native `needsApproval` — the AI SDK then suspends the tool call
 * (emitting a `tool-approval-request`) until the user approves, instead of the
 * old staged-pending dead-end. This is the ONE place the confirm policy lives:
 *  - a `confirm`-risk control: gated unless the org is autonomous AND the change
 *    is personal (a platform-wide `org` setting, and the autonomy switch itself,
 *    always stay gated — their blast radius is wider than one user's undo);
 *  - a collection `add`: gated unless autonomous, and ALWAYS when the collection
 *    marks `alwaysConfirm` (installing third-party code);
 *  - a collection `remove`: gated unless autonomous (reversible by re-adding).
 * Anything the caller can't access, or a safe/read action, needs no approval —
 * the action itself will return not_found/apply the trivial change.
 */
export async function requiresApproval(reg: Registry, ctx: ManageContext, input: ManageInput): Promise<boolean> {
  if (input.action === "set") {
    const c = reg.get(input.target);
    if (!c || !canAccess(ctx, c)) return false;
    return c.risk === "confirm" && (!!c.alwaysConfirm || c.scope === "org" || !(await autonomous(reg, ctx)));
  }
  if (input.action === "add") {
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return false;
    // Args the schema OR validateAdd reject are doomed to fail at apply: skip the
    // approval card and let execute return the actionable error (invalid_value, or
    // validateAdd's friendly message) instead of making the user approve — or even
    // see — a change that can never apply. `canAccess` is only the COARSE role gate
    // (the folder collection is `user`-visible for personal folders), so without the
    // validateAdd pre-flight a non-admin was shown a SERVER-folder confirm card that
    // applyAdd then rejected. This honors validateAdd's own contract ("run BEFORE a
    // confirm card is shown ... refuse up front instead of previewing"); applyAdd
    // still re-checks it at apply. Pass parsed args so the prediction matches apply.
    const parsed = coll.addSchema?.safeParse(input.args);
    if (parsed && !parsed.success) return false;
    if (coll.validateAdd) {
      try {
        await coll.validateAdd(ctx, (parsed ? parsed.data : input.args) as Record<string, unknown>);
      } catch {
        return false;
      }
    }
    return !!coll.alwaysConfirm || !(await autonomous(reg, ctx));
  }
  if (input.action === "remove") {
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return false;
    return !(await autonomous(reg, ctx));
  }
  if (input.action === "enable") {
    // Enabling is an ACTIVATION (marketplace MCP ships disabled, an automation
    // spends unattended, a skill injects an instruction) — gated whenever the
    // collection opts in, and like `add`'s alwaysConfirm it survives autonomous
    // mode so a prompt-injected agent can never flip on third-party code alone.
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return false;
    return !!coll.confirmEnable;
  }
  // `disable` (and everything else) needs no approval — turning an item OFF is
  // safety-positive; the escalation risk lives entirely on the enable side.
  return false;
}

/** The before→after preview for an approval card — the same rich data the old
 *  confirm card showed, now fetched by the web card (and the Telegram buttons)
 *  from the tool call's input once the SDK suspends it for approval. `null` when
 *  the input isn't a gated change or the caller can't access the target. */
export async function preview(
  reg: Registry,
  ctx: ManageContext,
  input: ManageInput,
): Promise<{ controlId: string; title: string; before: string; after: string; impact?: string; details?: string; body?: string; items?: string[] } | null> {
  const t = manageT(ctx.locale);
  if (input.action === "set") {
    const c = reg.get(input.target);
    if (!c || !canAccess(ctx, c)) return null;
    const parsed = c.schema.safeParse(input.value);
    if (!parsed.success) return null;
    const before = await c.read(ctx);
    const rawImpact = c.impact ? await c.impact(ctx, parsed.data) : undefined;
    const impact = rawImpact ? loc(t, `impact.${keyOf(c.id)}`, rawImpact) : undefined;
    return { controlId: c.id, title: title(t, c), before: fmt(t, c, before), after: fmt(t, c, parsed.data), impact };
  }
  if (input.action === "add") {
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return null;
    // previewAdd may PROBE (reach the connector, count its tools; enumerate a
    // repo's skills) — so the user approves an informed change, not a blind one.
    const p = coll.previewAdd ? await coll.previewAdd(ctx, input.args) : { title: coll.title, after: "" };
    return { controlId: `${coll.id}:add`, title: p.title, before: "", after: p.after, impact: p.impact, details: p.details, body: p.body, items: p.items };
  }
  if (input.action === "remove") {
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return null;
    const it = (await coll.list(ctx)).find((x) => x.id === input.itemId);
    if (!it) return null;
    return { controlId: `${coll.id}:remove`, title: loc(t, "op.removeTitle", `Remove from ${collLabel(t, coll)}`, { coll: collLabel(t, coll) }), before: it.title, after: "—" };
  }
  if (input.action === "enable") {
    const coll = reg.collection(input.target);
    if (!coll || !canAccess(ctx, coll)) return null;
    const it = (await coll.list(ctx)).find((x) => x.id === input.itemId);
    if (!it) return null;
    const impact = coll.enableImpact ? loc(t, `impact.enable.${keyOf(coll.id)}`, coll.enableImpact) : undefined;
    return {
      controlId: `${coll.id}:enable`,
      title: loc(t, "op.enableTitle", `Enable "${it.title}"`, { name: it.title }),
      before: loc(t, "op.stateDisabled", "Disabled"),
      after: loc(t, "op.stateEnabled", "Enabled"),
      impact,
    };
  }
  return null;
}

// ── Server-side apply (the ONLY path a confirm-gated change or an undo runs) ───

/** Consume a staged pending id (authorized by the caller's session/callback, NOT
 *  the model) and execute it. This is what the web confirm endpoint and the
 *  Telegram callback call. */
export async function applyPending(reg: Registry, ctx: ManageContext, pendingId: string): Promise<ManageResult> {
  const store = await pendingStore(ctx);
  const rec = await store.consume(pendingId, ctx.userId);
  if (!rec) return err("confirm_expired", "This confirmation is no longer valid — please ask again.");
  // Apply in the SCOPE it was staged in — the web endpoint / Telegram callback
  // has no project context, but a project-scoped change captured its projectId.
  const ectx: ManageContext = { ...ctx, projectId: rec.projectId };
  const p = rec.payload as PendingPayload;
  return applySet(reg, ectx, p.controlId, p.value);
}

async function applySet(reg: Registry, ctx: ManageContext, controlId: string, value: string): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const c = reg.get(controlId);
  // canAccess re-reads ctx.isAdmin, so a user demoted between staging and applying
  // fails here (an admin control becomes invisible) — no separate role branch.
  if (!c || !canAccess(ctx, c)) return err("not_found", "Setting unavailable.");
  // Re-validate: state and the value's validity may have changed since staging.
  const parsed = c.schema.safeParse(value);
  if (!parsed.success) return err("invalid_value", parsed.error.issues[0]?.message ?? "Invalid value.");
  const before = await c.read(ctx);
  await c.apply(ctx, parsed.data);
  await record(ctx, "settings.update", c.id, { before, after: parsed.data });
  // Let other admins know a platform-wide setting changed (a dismissible banner on
  // their next visit). Production path only — pure dispatch tests inject ctx.audit
  // and must not touch the DB, matching the same signal `record` uses. Best-effort.
  if (c.scope === "org" && !ctx.audit) {
    try {
      const { noteOrgChange } = await import("./org-notice");
      await noteOrgChange(ctx.userId, c.id, parsed.data);
    } catch { /* a failed notice must never fail the applied change */ }
  }
  return settingResult(t, c, before, parsed.data, await stageUndo(ctx, c.id, before));
}

async function applyAdd(reg: Registry, ctx: ManageContext, collectionId: string, args: Record<string, unknown>): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const { coll, error } = resolveCollection(reg, ctx, collectionId);
  if (error) return error;
  if (!coll!.add) return err("unsupported", "This resource doesn't support adding.");
  try {
    if (coll!.validateAdd) await coll!.validateAdd(ctx, args); // re-check at apply time
    const { itemTitle, action } = await coll!.add(ctx, args);
    await record(ctx, `${coll!.auditNoun}.add`, coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, "op.added", `Added ${itemTitle}.`, { name: itemTitle }),
      data: { op: "added", collectionId: coll!.id, title: coll!.title, itemTitle, action, settingsPath: coll!.settingsPath },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function applyRemove(reg: Registry, ctx: ManageContext, collectionId: string, itemId: string): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const { coll, error } = resolveCollection(reg, ctx, collectionId);
  if (error) return error;
  if (!coll!.remove) return err("unsupported", "This resource doesn't support removal.");
  try {
    const { itemTitle } = await coll!.remove(ctx, itemId);
    await record(ctx, `${coll!.auditNoun}.remove`, coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, "op.removed", `Removed ${itemTitle}.`, { name: itemTitle }),
      data: { op: "removed", collectionId: coll!.id, title: coll!.title, itemTitle, settingsPath: coll!.settingsPath },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

/** Stage an undo for a just-applied setting change (restoring `prev`). Best-effort
 *  — losing the undo handle must not fail the change that already happened. */
async function stageUndo(ctx: ManageContext, controlId: string, prev: string): Promise<string | undefined> {
  try {
    const store = await pendingStore(ctx);
    return await store.stage({
      userId: ctx.userId,
      projectId: ctx.projectId,
      kind: "undo",
      payload: { op: "set", controlId, value: prev } satisfies PendingPayload,
    });
  } catch {
    return undefined;
  }
}

function settingResult(t: ManageT, c: Control, before: string, after: string, undoPendingId?: string): ManageResult {
  return {
    status: "ok",
    render: "setting",
    summary: `"${title(t, c)}" → ${fmt(t, c, after)}`,
    data: { controlId: c.id, title: title(t, c), before: fmt(t, c, before), after: fmt(t, c, after), undoPendingId, reload: c.reloadOnApply || undefined },
  };
}

// ── Collections ──────────────────────────────────────────────────────────────

function resolveCollection(reg: Registry, ctx: ManageContext, target: string): { coll?: Collection; error?: ManageResult } {
  const coll = reg.collection(target);
  if (!coll || !canAccess(ctx, coll)) return { error: err("not_found", `No resource "${target}".`) };
  return { coll };
}

async function add(reg: Registry, ctx: ManageContext, input: Extract<ManageInput, { action: "add" }>): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, input.target);
  if (error) return error;
  if (!coll!.add || !coll!.addSchema) return err("unsupported", "This resource doesn't support adding.");

  const parsed = coll!.addSchema.safeParse(input.args);
  if (!parsed.success) {
    // Echo the collection's usage so the model repairs the args in ONE step
    // instead of guessing (the shapes no longer live in the tool description).
    const msg = parsed.error.issues[0]?.message ?? "Invalid data.";
    return err("invalid_value", coll!.usage ? `${msg}\n\nUsage — ${coll!.usage}` : msg);
  }
  // Native tool approval already gated this (see `requiresApproval`): the SDK
  // suspended the call and the user approved, or autonomy let it through. Apply
  // directly — `applyAdd` re-runs `validateAdd` at apply time, so a change that
  // went stale between approval and apply still fails safely.
  return applyAdd(reg, ctx, coll!.id, parsed.data as Record<string, unknown>);
}

async function remove(reg: Registry, ctx: ManageContext, input: Extract<ManageInput, { action: "remove" }>): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, input.target);
  if (error) return error;
  if (!coll!.remove) return err("unsupported", "This resource doesn't support removal.");
  const it = (await coll!.list(ctx)).find((x) => x.id === input.itemId);
  if (!it) return err("not_found", "No such item.");
  // Native tool approval already gated this (see `requiresApproval`) — apply.
  return applyRemove(reg, ctx, coll!.id, input.itemId);
}

async function toggle(reg: Registry, ctx: ManageContext, target: string, itemId: string, enabled: boolean): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.setEnabled) return err("unsupported", "This resource doesn't support enable/disable.");
  try {
    const { itemTitle } = await coll!.setEnabled(ctx, itemId, enabled);
    // Only reachable for collections that DO support enable/disable (guarded by the
    // setEnabled check above) — so nouns without those audit actions (e.g. "folder")
    // never actually reach here; the cast just tells the type-checker that.
    await record(ctx, `${coll!.auditNoun}.${enabled ? "enable" : "disable"}` as AuditAction, coll!.id, { item: itemTitle });
    const opKey = enabled ? "op.enabled" : "op.disabled";
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, opKey, `${itemTitle} ${enabled ? "enabled" : "disabled"}.`, { name: itemTitle }),
      data: { op: enabled ? "enabled" : "disabled", collectionId: coll!.id, title: coll!.title, itemTitle, settingsPath: coll!.settingsPath },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function debug(reg: Registry, ctx: ManageContext, target: string, itemId: string): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.debug) return err("unsupported", "This resource doesn't support diagnostics.");
  try {
    const r = await coll!.debug(ctx, itemId);
    return {
      status: "ok",
      render: "debug",
      summary: `${r.itemTitle}: ${r.state}`,
      data: { title: coll!.title, itemTitle: r.itemTitle, state: r.state, detail: r.detail, hint: r.hint, action: r.action },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function edit(reg: Registry, ctx: ManageContext, target: string, itemId: string): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.edit) return err("unsupported", "This resource can't be edited.");
  try {
    const { itemTitle, path, instruction } = await coll!.edit(ctx, itemId);
    // A prepare step, not a change — it only writes into the caller's own workspace,
    // so it applies directly (the confirm gate fires later, on the save-back `add`).
    return {
      status: "ok",
      render: "resource",
      summary: instruction,
      data: { op: "editing", collectionId: coll!.id, title: coll!.title, itemTitle, path },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function connect(reg: Registry, ctx: ManageContext, target: string, itemId: string): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.connect) return err("unsupported", "This resource doesn't support connecting.");
  try {
    const action = await coll!.connect(ctx, itemId);
    if (!action) return { status: "ok", render: "value", summary: "Already connected." };
    return { status: "action_required", render: "action_required", summary: action.description ?? action.label, action };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}
