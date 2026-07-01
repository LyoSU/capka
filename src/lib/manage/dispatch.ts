import { hashArgs, signToken, verifyToken } from "./token";
import { canAccess, type Registry } from "./registry";
import type { Collection, Control, ManageContext, ManageInput, ManageResult } from "./types";
import type { AuditAction } from "@/lib/governance/types";

function fmt(c: Control, v: string): string {
  return c.format ? c.format(v) : v;
}

function err(code: string, summary: string): ManageResult {
  return { status: "error", render: "error", code, summary };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Не вдалося виконати дію.";
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

/** Issue a confirm token bound to (user, action-key, args). */
function issueConfirm(ctx: ManageContext, controlKey: string, argsHash: string): string {
  return signToken({ purpose: "confirm", controlId: controlKey, argsHash, userId: ctx.userId }, ctx.secret, {
    now: ctx.now?.(),
  });
}

/** Validate a confirm token against the exact change it must authorize. */
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
  const groups: Record<string, { id: string; title: string; description: string }[]> = {};
  for (const c of reg.visibleTo(ctx)) {
    (groups[c.scope] ??= []).push({ id: c.id, title: c.title, description: c.description });
  }
  for (const coll of reg.visibleCollectionsTo(ctx)) {
    (groups.collections ??= []).push({ id: coll.id, title: coll.title, description: coll.description });
  }
  return { status: "ok", render: "capabilities", summary: "Доступні можливості керування", data: groups };
}

async function list(reg: Registry, ctx: ManageContext): Promise<ManageResult> {
  const items = await Promise.all(
    reg.visibleTo(ctx).map(async (c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      scope: c.scope,
      requiredRole: c.requiredRole,
      risk: c.risk,
      current: fmt(c, await c.read(ctx)),
    })),
  );
  const collections = reg.visibleCollectionsTo(ctx).map((c) => ({ id: c.id, title: c.title, description: c.description }));
  return { status: "ok", render: "list", summary: `${items.length} налаштувань, ${collections.length} колекцій`, data: { settings: items, collections } };
}

async function get(reg: Registry, ctx: ManageContext, target: string): Promise<ManageResult> {
  const c = reg.get(target);
  if (c && canAccess(ctx, c)) {
    const v = await c.read(ctx);
    return {
      status: "ok",
      render: "value",
      summary: `${c.title}: ${fmt(c, v)}`,
      data: { id: c.id, title: c.title, value: v, display: fmt(c, v) },
    };
  }
  const coll = reg.collection(target);
  if (coll && canAccess(ctx, coll)) {
    const items = await coll.list(ctx);
    return {
      status: "ok",
      render: "collection",
      summary: `${coll.title}: ${items.length}`,
      data: { collectionId: coll.id, title: coll.title, items },
    };
  }
  return err("not_found", `Немає налаштування «${target}».`);
}

async function set(
  reg: Registry,
  ctx: ManageContext,
  input: Extract<ManageInput, { action: "set" }>,
): Promise<ManageResult> {
  const c = reg.get(input.target);
  // A non-admin can't even learn an admin control exists — same answer as a typo.
  if (!c || !canAccess(ctx, c)) return err("not_found", `Немає налаштування «${input.target}».`);
  if (c.requiredRole === "admin" && !ctx.isAdmin) return err("forbidden", "Ця дія доступна лише адміністратору.");

  const parsed = c.schema.safeParse(input.value);
  if (!parsed.success) {
    return err("invalid_value", parsed.error.issues[0]?.message ?? "Некоректне значення.");
  }
  const value = parsed.data;
  const before = await c.read(ctx);
  const argsHash = hashArgs({ target: c.id, value });

  if (c.risk === "confirm") {
    if (!input.confirmToken) {
      const impact = c.impact ? await c.impact(ctx, value) : undefined;
      return {
        status: "confirm_required",
        render: "confirm",
        summary:
          `Зміну «${c.title}» підготовлено й показано користувачу як картку з кнопкою «Підтвердити». ` +
          `Користувач АВТОРИЗОВАНИЙ (роль уже перевірено на сервері) — не кажи, що бракує прав. ` +
          `Зупинись і чекай: нічого не застосовуй і не викликай set знову, доки користувач не підтвердить. Відповідай щонайбільше одним коротким рядком.`,
        confirmToken: issueConfirm(ctx, c.id, argsHash),
        preview: { controlId: c.id, title: c.title, before: fmt(c, before), after: fmt(c, value), impact },
      };
    }
    if (!confirmOk(ctx, c.id, argsHash, input.confirmToken)) {
      return err("confirm_invalid", "Підтвердження недійсне або застаріле — перегляньте зміну ще раз.");
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
    summary: `«${c.title}» → ${fmt(c, value)}`,
    data: { controlId: c.id, title: c.title, before: fmt(c, before), after: fmt(c, value), undoToken },
  };
}

async function undo(reg: Registry, ctx: ManageContext, undoToken: string): Promise<ManageResult> {
  const v = verifyToken(undoToken, ctx.secret, ctx.now?.());
  if (!v.ok || v.payload.purpose !== "undo" || v.payload.userId !== ctx.userId) {
    return err("undo_invalid", "Скасування недійсне або застаріле.");
  }
  const c = reg.get(v.payload.controlId);
  if (!c || !canAccess(ctx, c)) return err("not_found", "Налаштування недоступне.");
  if (c.requiredRole === "admin" && !ctx.isAdmin) return err("forbidden", "Ця дія доступна лише адміністратору.");

  const parsed = c.schema.safeParse(v.payload.prev);
  if (!parsed.success) return err("undo_invalid", "Попереднє значення більше недійсне.");

  const current = await c.read(ctx);
  await c.apply(ctx, parsed.data);
  await record(ctx, "settings.undo", c.id, { restored: parsed.data });
  return {
    status: "ok",
    render: "setting",
    summary: `«${c.title}» відновлено.`,
    data: { controlId: c.id, title: c.title, before: fmt(c, current), after: fmt(c, parsed.data) },
  };
}

// ── Collections ──────────────────────────────────────────────────────────────

function resolveCollection(reg: Registry, ctx: ManageContext, target: string): { coll?: Collection; error?: ManageResult } {
  const coll = reg.collection(target);
  if (!coll || !canAccess(ctx, coll)) return { error: err("not_found", `Немає ресурсу «${target}».`) };
  return { coll };
}

async function add(reg: Registry, ctx: ManageContext, input: Extract<ManageInput, { action: "add" }>): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, input.target);
  if (error) return error;
  if (!coll!.add || !coll!.addSchema) return err("unsupported", "Цей ресурс не підтримує додавання.");

  const parsed = coll!.addSchema.safeParse(input.args);
  if (!parsed.success) return err("invalid_value", parsed.error.issues[0]?.message ?? "Некоректні дані.");
  const args = parsed.data as Record<string, unknown>;
  const key = `${coll!.id}:add`;
  const argsHash = hashArgs(args);

  if (!input.confirmToken) {
    const preview = coll!.previewAdd?.(ctx, args) ?? { title: coll!.title, after: "" };
    return {
      status: "confirm_required",
      render: "confirm",
      summary:
        `Додавання до «${coll!.title}» підготовлено й показано користувачу як картку з кнопкою «Підтвердити». ` +
        `Користувач АВТОРИЗОВАНИЙ — не кажи, що бракує прав. Зупинись і чекай на підтвердження; відповідай щонайбільше одним коротким рядком.`,
      confirmToken: issueConfirm(ctx, key, argsHash),
      preview: { controlId: key, title: preview.title, before: "", after: preview.after, impact: preview.impact },
    };
  }
  if (!confirmOk(ctx, key, argsHash, input.confirmToken)) {
    return err("confirm_invalid", "Підтвердження недійсне або застаріле — перегляньте ще раз.");
  }
  try {
    const { itemTitle, action } = await coll!.add(ctx, args);
    await record(ctx, "connector.add", coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: `Додано «${itemTitle}».`,
      data: { op: "added", collectionId: coll!.id, title: coll!.title, itemTitle, action },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function remove(reg: Registry, ctx: ManageContext, input: Extract<ManageInput, { action: "remove" }>): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, input.target);
  if (error) return error;
  if (!coll!.remove) return err("unsupported", "Цей ресурс не підтримує видалення.");

  const key = `${coll!.id}:remove`;
  const argsHash = hashArgs({ itemId: input.itemId });
  if (!input.confirmToken) {
    const items = await coll!.list(ctx);
    const it = items.find((x) => x.id === input.itemId);
    if (!it) return err("not_found", "Немає такого елемента.");
    return {
      status: "confirm_required",
      render: "confirm",
      summary: `Підтвердіть видалення з «${coll!.title}».`,
      confirmToken: issueConfirm(ctx, key, argsHash),
      preview: { controlId: key, title: `Видалення з «${coll!.title}»`, before: it.title, after: "—" },
    };
  }
  if (!confirmOk(ctx, key, argsHash, input.confirmToken)) {
    return err("confirm_invalid", "Підтвердження недійсне або застаріле — перегляньте ще раз.");
  }
  try {
    const { itemTitle } = await coll!.remove(ctx, input.itemId);
    await record(ctx, "connector.remove", coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: `Видалено «${itemTitle}».`,
      data: { op: "removed", collectionId: coll!.id, title: coll!.title, itemTitle },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function toggle(reg: Registry, ctx: ManageContext, target: string, itemId: string, enabled: boolean): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.setEnabled) return err("unsupported", "Цей ресурс не підтримує вмикання/вимикання.");
  try {
    const { itemTitle } = await coll!.setEnabled(ctx, itemId, enabled);
    await record(ctx, enabled ? "connector.enable" : "connector.disable", coll!.id, { item: itemTitle });
    return {
      status: "ok",
      render: "resource",
      summary: `«${itemTitle}» ${enabled ? "увімкнено" : "вимкнено"}.`,
      data: { op: enabled ? "enabled" : "disabled", collectionId: coll!.id, title: coll!.title, itemTitle },
    };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}

async function debug(reg: Registry, ctx: ManageContext, target: string, itemId: string): Promise<ManageResult> {
  const { coll, error } = resolveCollection(reg, ctx, target);
  if (error) return error;
  if (!coll!.debug) return err("unsupported", "Цей ресурс не підтримує діагностику.");
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
  if (!coll!.connect) return err("unsupported", "Цей ресурс не підтримує підключення.");
  try {
    const action = await coll!.connect(ctx, itemId);
    if (!action) return { status: "ok", render: "value", summary: "Вже підключено." };
    return { status: "action_required", render: "action_required", summary: action.description ?? action.label, action };
  } catch (e) {
    return err("apply_failed", errMsg(e));
  }
}
