import { hashArgs, signToken, verifyToken } from "./token";
import { canAccess, type Registry } from "./registry";
import { manageT, loc, locValue, keyOf, type ManageT } from "./i18n";
import type { Collection, Control, ManageContext, ManageInput, ManageResult } from "./types";
import type { AuditAction } from "@/lib/governance/types";

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

function err(code: string, summary: string): ManageResult {
  return { status: "error", render: "error", code, summary };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "The action could not be completed.";
}

/** Record a mutation in the tamper-evident audit trail. Best-effort and lazy:
 *  the governance audit (and thus the DB) is only imported when no test override
 *  is supplied, so pure dispatch tests never touch a database. */
async function record(
  ctx: ManageContext,
  action: string,
  targetKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (ctx.audit) {
    await ctx.audit({ action, targetType: "manage", targetKey, detail });
    return;
  }
  const { audit } = await import("@/lib/governance/audit");
  await audit({ actorId: ctx.userId, action: action as AuditAction, targetType: "manage", targetKey, detail });
}

function issueConfirm(ctx: ManageContext, controlKey: string, argsHash: string): string {
  return signToken({ purpose: "confirm", controlId: controlKey, argsHash, userId: ctx.userId }, ctx.secret, {
    now: ctx.now?.(),
  });
}

function confirmOk(ctx: ManageContext, controlKey: string, argsHash: string, token: string): boolean {
  const v = verifyToken(token, ctx.secret, ctx.now?.());
  return (
    v.ok &&
    v.payload.purpose === "confirm" &&
    v.payload.userId === ctx.userId &&
    v.payload.controlId === controlKey &&
    v.payload.argsHash === argsHash
  );
}

/** Instruction handed back to the model on a confirm request. English (the model
 *  relays to the user in their own language); the visible card is localized. */
const CONFIRM_NOTE =
  "The change is staged and shown to the user as a card with a Confirm button. The user is ALREADY authorized (the server checked). Do not claim missing permission and do not re-ask in prose. Reply with at most one short line, then STOP and wait — the confirmation arrives as a new message; only then re-call with the same value + confirmToken.";

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
    case "undo":
      return undo(reg, ctx, input.undoToken);
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
  }
}

function capabilities(reg: Registry, ctx: ManageContext): ManageResult {
  const t = manageT(ctx.locale);
  const groups: Record<string, { id: string; title: string; description: string }[]> = {};
  for (const c of reg.visibleTo(ctx)) {
    (groups[c.scope] ??= []).push({ id: c.id, title: title(t, c), description: c.description });
  }
  for (const coll of reg.visibleCollectionsTo(ctx)) {
    (groups.collections ??= []).push({ id: coll.id, title: coll.title, description: coll.description });
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
  const collections = reg.visibleCollectionsTo(ctx).map((c) => ({ id: c.id, title: c.title, description: c.description }));
  return { status: "ok", render: "list", summary: `${items.length} settings, ${collections.length} collections`, data: { settings: items, collections } };
}

async function get(reg: Registry, ctx: ManageContext, target: string): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const c = reg.get(target);
  if (c && canAccess(ctx, c)) {
    const v = await c.read(ctx);
    return {
      status: "ok",
      render: "value",
      summary: `${title(t, c)}: ${fmt(t, c, v)}`,
      data: { id: c.id, title: title(t, c), value: v, display: fmt(t, c, v) },
    };
  }
  const coll = reg.collection(target);
  if (coll && canAccess(ctx, coll)) {
    const items = await coll.list(ctx);
    return {
      status: "ok",
      render: "collection",
      summary: `${coll.title}: ${items.length}`,
      data: { collectionId: coll.id, title: collLabel(t, coll), items },
    };
  }
  return err("not_found", `No setting "${target}".`);
}

async function set(
  reg: Registry,
  ctx: ManageContext,
  input: Extract<ManageInput, { action: "set" }>,
): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const c = reg.get(input.target);
  // A non-admin can't even learn an admin control exists — same answer as a typo.
  if (!c || !canAccess(ctx, c)) return err("not_found", `No setting "${input.target}".`);
  if (c.requiredRole === "admin" && !ctx.isAdmin) return err("forbidden", "This action is admin-only.");

  const parsed = c.schema.safeParse(input.value);
  if (!parsed.success) {
    return err("invalid_value", parsed.error.issues[0]?.message ?? "Invalid value.");
  }
  const value = parsed.data;
  const before = await c.read(ctx);
  const argsHash = hashArgs({ target: c.id, value });

  if (c.risk === "confirm") {
    if (!input.confirmToken) {
      const rawImpact = c.impact ? await c.impact(ctx, value) : undefined;
      const impact = rawImpact ? loc(t, `impact.${keyOf(c.id)}`, rawImpact) : undefined;
      return {
        status: "confirm_required",
        render: "confirm",
        summary: CONFIRM_NOTE,
        confirmToken: issueConfirm(ctx, c.id, argsHash),
        preview: { controlId: c.id, title: title(t, c), before: fmt(t, c, before), after: fmt(t, c, value), impact },
      };
    }
    if (!confirmOk(ctx, c.id, argsHash, input.confirmToken)) {
      return err("confirm_invalid", "The confirmation is invalid or expired — review the change again.");
    }
  }

  await c.apply(ctx, value);
  await record(ctx, "settings.update", c.id, { before, after: value });
  const undoToken = signToken({ purpose: "undo", controlId: c.id, prev: before, userId: ctx.userId }, ctx.secret, {
    now: ctx.now?.(),
  });
  return {
    status: "ok",
    render: "setting",
    summary: `"${title(t, c)}" → ${fmt(t, c, value)}`,
    data: { controlId: c.id, title: title(t, c), before: fmt(t, c, before), after: fmt(t, c, value), undoToken },
  };
}

async function undo(reg: Registry, ctx: ManageContext, undoToken: string): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const v = verifyToken(undoToken, ctx.secret, ctx.now?.());
  if (!v.ok || v.payload.purpose !== "undo" || v.payload.userId !== ctx.userId) {
    return err("undo_invalid", "The undo is invalid or expired.");
  }
  const c = reg.get(v.payload.controlId);
  if (!c || !canAccess(ctx, c)) return err("not_found", "Setting unavailable.");
  if (c.requiredRole === "admin" && !ctx.isAdmin) return err("forbidden", "This action is admin-only.");

  const parsed = c.schema.safeParse(v.payload.prev);
  if (!parsed.success) return err("undo_invalid", "The previous value is no longer valid.");

  const current = await c.read(ctx);
  await c.apply(ctx, parsed.data);
  await record(ctx, "settings.undo", c.id, { restored: parsed.data });
  return {
    status: "ok",
    render: "setting",
    summary: `"${title(t, c)}" restored.`,
    data: { controlId: c.id, title: title(t, c), before: fmt(t, c, current), after: fmt(t, c, parsed.data) },
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
  if (!parsed.success) return err("invalid_value", parsed.error.issues[0]?.message ?? "Invalid data.");
  const args = parsed.data as Record<string, unknown>;
  const key = `${coll!.id}:add`;
  const argsHash = hashArgs(args);

  if (!input.confirmToken) {
    const preview = coll!.previewAdd?.(ctx, args) ?? { title: coll!.title, after: "" };
    return {
      status: "confirm_required",
      render: "confirm",
      summary: CONFIRM_NOTE,
      confirmToken: issueConfirm(ctx, key, argsHash),
      preview: { controlId: key, title: preview.title, before: "", after: preview.after, impact: preview.impact },
    };
  }
  if (!confirmOk(ctx, key, argsHash, input.confirmToken)) {
    return err("confirm_invalid", "The confirmation is invalid or expired — review again.");
  }
  try {
    const { itemTitle, action } = await coll!.add(ctx, args);
    await record(ctx, "connector.add", coll!.id, { item: itemTitle });
    const t = manageT(ctx.locale);
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, "op.added", `Added ${itemTitle}.`, { name: itemTitle }),
      data: { op: "added", collectionId: coll!.id, title: coll!.title, itemTitle, action },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function remove(reg: Registry, ctx: ManageContext, input: Extract<ManageInput, { action: "remove" }>): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const { coll, error } = resolveCollection(reg, ctx, input.target);
  if (error) return error;
  if (!coll!.remove) return err("unsupported", "This resource doesn't support removal.");

  const key = `${coll!.id}:remove`;
  const argsHash = hashArgs({ itemId: input.itemId });
  if (!input.confirmToken) {
    const items = await coll!.list(ctx);
    const it = items.find((x) => x.id === input.itemId);
    if (!it) return err("not_found", "No such item.");
    return {
      status: "confirm_required",
      render: "confirm",
      summary: CONFIRM_NOTE,
      confirmToken: issueConfirm(ctx, key, argsHash),
      preview: { controlId: key, title: loc(t, "op.removeTitle", `Remove from ${collLabel(t, coll!)}`, { coll: collLabel(t, coll!) }), before: it.title, after: "—" },
    };
  }
  if (!confirmOk(ctx, key, argsHash, input.confirmToken)) {
    return err("confirm_invalid", "The confirmation is invalid or expired — review again.");
  }
  try {
    const { itemTitle } = await coll!.remove(ctx, input.itemId);
    await record(ctx, "connector.remove", coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, "op.removed", `Removed ${itemTitle}.`, { name: itemTitle }),
      data: { op: "removed", collectionId: coll!.id, title: coll!.title, itemTitle },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function toggle(reg: Registry, ctx: ManageContext, target: string, itemId: string, enabled: boolean): Promise<ManageResult> {
  const t = manageT(ctx.locale);
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.setEnabled) return err("unsupported", "This resource doesn't support enable/disable.");
  try {
    const { itemTitle } = await coll!.setEnabled(ctx, itemId, enabled);
    await record(ctx, enabled ? "connector.enable" : "connector.disable", coll!.id, { item: itemTitle });
    const opKey = enabled ? "op.enabled" : "op.disabled";
    return {
      status: "ok",
      render: "resource",
      summary: loc(t, opKey, `${itemTitle} ${enabled ? "enabled" : "disabled"}.`, { name: itemTitle }),
      data: { op: enabled ? "enabled" : "disabled", collectionId: coll!.id, title: coll!.title, itemTitle },
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
