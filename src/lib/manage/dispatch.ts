import { hashArgs, signToken, verifyToken } from "./token";
import { canAccess, type Registry } from "./registry";
import type { Control, ManageContext, ManageInput, ManageResult } from "./types";
import type { AuditAction } from "@/lib/governance/types";

function fmt(c: Control, v: string): string {
  return c.format ? c.format(v) : v;
}

function err(code: string, summary: string): ManageResult {
  return { status: "error", render: "error", code, summary };
}

/** Record a mutation in the tamper-evident audit trail. Best-effort and lazy:
 *  the governance audit (and thus the DB) is only imported when no test override
 *  is supplied, so pure dispatch tests never touch a database. */
async function record(
  ctx: ManageContext,
  action: string,
  control: Control,
  detail: Record<string, unknown>,
): Promise<void> {
  if (ctx.audit) {
    await ctx.audit({ action, targetType: "setting", targetKey: control.id, detail });
    return;
  }
  const { audit } = await import("@/lib/governance/audit");
  await audit({ actorId: ctx.userId, action: action as AuditAction, targetType: "setting", targetKey: control.id, detail });
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
  }
}

function capabilities(reg: Registry, ctx: ManageContext): ManageResult {
  const groups: Record<string, { id: string; title: string; description: string }[]> = {};
  for (const c of reg.visibleTo(ctx)) {
    (groups[c.scope] ??= []).push({ id: c.id, title: c.title, description: c.description });
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
  return { status: "ok", render: "list", summary: `${items.length} налаштувань`, data: items };
}

async function get(reg: Registry, ctx: ManageContext, target: string): Promise<ManageResult> {
  const c = reg.get(target);
  if (!c || !canAccess(ctx, c)) return err("not_found", `Немає налаштування «${target}».`);
  const v = await c.read(ctx);
  return {
    status: "ok",
    render: "value",
    summary: `${c.title}: ${fmt(c, v)}`,
    data: { id: c.id, title: c.title, value: v, display: fmt(c, v) },
  };
}

async function set(
  reg: Registry,
  ctx: ManageContext,
  input: Extract<ManageInput, { action: "set" }>,
): Promise<ManageResult> {
  const c = reg.get(input.target);
  // A non-admin can't even learn an admin control exists — same answer as a typo.
  if (!c || !canAccess(ctx, c)) return err("not_found", `Немає налаштування «${input.target}».`);
  // Defense in depth: the role gate is re-checked here, not trusted from `list`.
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
      const token = signToken({ purpose: "confirm", controlId: c.id, argsHash, userId: ctx.userId }, ctx.secret, {
        now: ctx.now?.(),
      });
      const impact = c.impact ? await c.impact(ctx, value) : undefined;
      return {
        status: "confirm_required",
        render: "confirm",
        summary: `Підтвердіть зміну «${c.title}».`,
        confirmToken: token,
        preview: { controlId: c.id, title: c.title, before: fmt(c, before), after: fmt(c, value), impact },
      };
    }
    const v = verifyToken(input.confirmToken, ctx.secret, ctx.now?.());
    if (
      !v.ok ||
      v.payload.purpose !== "confirm" ||
      v.payload.userId !== ctx.userId ||
      v.payload.controlId !== c.id ||
      v.payload.argsHash !== argsHash
    ) {
      return err("confirm_invalid", "Підтвердження недійсне або застаріле — перегляньте зміну ще раз.");
    }
  }

  await c.apply(ctx, value);
  await record(ctx, "settings.update", c, { before, after: value });
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
  await record(ctx, "settings.undo", c, { restored: parsed.data });
  return {
    status: "ok",
    render: "setting",
    summary: `«${c.title}» відновлено.`,
    data: { controlId: c.id, title: c.title, before: fmt(c, current), after: fmt(c, parsed.data) },
  };
}
