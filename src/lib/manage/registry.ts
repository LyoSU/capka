import type { Control, ManageContext } from "./types";

/** A read-only lookup over the registered controls, with role filtering baked in
 *  so callers can't accidentally surface an admin control to a regular user. */
export interface Registry {
  get(id: string): Control | undefined;
  all(): Control[];
  /** Controls this caller is allowed to see and touch, in registration order. */
  visibleTo(ctx: ManageContext): Control[];
}

/** True if `ctx` may see/use `control`. A regular user sees only `user`-role
 *  controls; an admin sees everything. This is the single place the role gate is
 *  expressed, so `list`/`get`/`set` all agree on what's visible. */
export function canAccess(ctx: ManageContext, control: Control): boolean {
  return control.requiredRole === "user" || ctx.isAdmin;
}

export function createRegistry(controls: Control[]): Registry {
  const byId = new Map(controls.map((c) => [c.id, c]));
  return {
    get: (id) => byId.get(id),
    all: () => [...controls],
    visibleTo: (ctx) => controls.filter((c) => canAccess(ctx, c)),
  };
}
