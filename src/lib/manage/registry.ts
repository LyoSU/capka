import type { Collection, Control, ManageContext } from "./types";

/** A read-only lookup over the registered controls and collections, with role
 *  filtering baked in so callers can't accidentally surface an admin-only
 *  capability to a regular user. */
export interface Registry {
  get(id: string): Control | undefined;
  all(): Control[];
  /** Controls this caller is allowed to see and touch, in registration order. */
  visibleTo(ctx: ManageContext): Control[];
  collection(id: string): Collection | undefined;
  collections(): Collection[];
  visibleCollectionsTo(ctx: ManageContext): Collection[];
}

/** True if `ctx` may see/use `c`. A regular user sees only `user`-role
 *  capabilities; an admin sees everything. Fine-grained per-item authorization
 *  (e.g. only an admin may add an ORG connector) lives inside the collection,
 *  which has the DB context this coarse gate doesn't. */
export function canAccess(ctx: ManageContext, c: { requiredRole: "user" | "admin" }): boolean {
  return c.requiredRole === "user" || ctx.isAdmin;
}

export function createRegistry(controls: Control[], collections: Collection[] = []): Registry {
  const byId = new Map(controls.map((c) => [c.id, c]));
  const collById = new Map(collections.map((c) => [c.id, c]));
  return {
    get: (id) => byId.get(id),
    all: () => [...controls],
    visibleTo: (ctx) => controls.filter((c) => canAccess(ctx, c)),
    collection: (id) => collById.get(id),
    collections: () => [...collections],
    visibleCollectionsTo: (ctx) => collections.filter((c) => canAccess(ctx, c)),
  };
}
