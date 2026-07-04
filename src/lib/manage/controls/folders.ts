import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { attachedFolders, projects } from "@/lib/db/schema";
import { getSetting, getSandboxNetworkDefault } from "@/lib/settings";
import { validateMount, createSession, type SandboxMount } from "@/lib/sandbox/client";
import { sanitizeFolderName } from "@/lib/folder-bridge/filter";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext } from "../types";

export type PcFolderLevel = "off" | "admins" | "everyone";

/** Server (host) folder bind-mounts: a single admin on/off gate. Default OFF —
 *  nothing mounts until an admin turns it on (zero-config principle). */
export async function hostFolderEnabled(): Promise<boolean> {
  return (await getSetting("host_folder_access")) === "true";
}

/** Personal (PC) folder sync: who may connect a folder from their own computer.
 *  Default OFF. Separate from the server-folder gate — the two are independent. */
export async function pcFolderLevel(): Promise<PcFolderLevel> {
  const v = await getSetting("pc_folder_access");
  return v === "admins" || v === "everyone" ? v : "off";
}

/** May a user of this role connect a PC folder at the given access level? The one
 *  predicate the access route, the attach POST, the upload route, and this control
 *  all share — so a future access level can't be enforced in one place and missed
 *  in another. */
export function canAttachPc(level: PcFolderLevel, isAdmin: boolean): boolean {
  return level === "everyone" || (level === "admins" && isAdmin);
}

// add args cover BOTH kinds: {path} attaches a server folder (host, admin-only);
// {kind:"pc"} connects a folder from the user's own computer (they pick it in the
// browser). Kept loose (path optional) so the friendly validateAdd errors — not a
// schema rejection — explain what's missing.
const addSchema = z.object({
  kind: z.enum(["host", "pc"]).optional(),
  path: z.string().min(1).optional(),
  name: z.string().optional(),
  readOnly: z.enum(["true", "false"]).optional(),
});
type AddArgs = z.infer<typeof addSchema>;

/** Mount name for a folder: explicit `name`, else the path's basename, else a
 *  generic fallback — sanitized to the safe id charset. */
function deriveName(args: AddArgs): string {
  const raw = args.name?.trim() || (args.path ? posix.basename(args.path) : "") || "folder";
  return sanitizeFolderName(raw) || "folder";
}

/** Friendly, role-neutral message for a controller mount-safety rejection. */
function mountError(code?: string): string {
  if (code === "outside_allowlist") return "That path isn't within the folders this server allows sharing.";
  if (code === "not_absolute") return "Enter a full path starting with / (e.g. /srv/reports).";
  return "That folder can't be shared — it's a system location on the server.";
}

/** All host folders for a session as controller mount specs — GATED on the org
 *  setting, so it is the single chokepoint for "what does this session mount".
 *  Returns [] when host_folder_access is off, so turning the setting off actually
 *  un-mounts already-attached server folders on the next session (re)create,
 *  instead of leaving the operator's filesystem exposed until idle-TTL. Every
 *  createSession caller (runner, this control, the download route) goes through
 *  here so the gate can't be enforced in one place and missed in another. */
export async function sessionMounts(sessionKey: string): Promise<SandboxMount[]> {
  if (!(await hostFolderEnabled())) return [];
  const rows = await db.select().from(attachedFolders)
    .where(and(eq(attachedFolders.sessionKey, sessionKey), eq(attachedFolders.kind, "host")));
  return rows.map((f) => ({ hostPath: f.hostPath!, name: f.name, ro: f.readOnly }));
}

/** The network mode the session runs with, so a folder-driven recreate doesn't
 *  silently downgrade an egress-enabled sandbox to isolated (mirrors runner.ts). */
export async function resolveNetwork(projectId: string | null): Promise<"none" | "bridge"> {
  if (projectId) {
    const [p] = await db.select({ net: projects.sandboxNetwork }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (p?.net === "bridge") return "bridge";
  }
  return getSandboxNetworkDefault();
}

/** Recreate the sandbox with the current host-folder set (fire-and-forget). The
 *  controller detects the mount drift and swaps the container; workspace files
 *  survive. A transient failure just defers the attach to the next turn. */
function reattach(ctx: ManageContext): void {
  const { sessionKey, userId, projectId } = ctx;
  if (!sessionKey) return;
  void (async () => {
    try {
      await createSession(sessionKey, userId, await resolveNetwork(projectId), await sessionMounts(sessionKey));
    } catch { /* next turn's ensureSession will apply the new mounts */ }
  })();
}

async function names(sessionKey: string): Promise<Set<string>> {
  const rows = await db.select({ name: attachedFolders.name }).from(attachedFolders).where(eq(attachedFolders.sessionKey, sessionKey));
  return new Set(rows.map((r) => r.name));
}

export const folderCollection: Collection = {
  id: "folder",
  title: "Folders",
  description: "Folders attached to this workspace — server folders (admin) and folders from the user's own computer.",
  usage:
    'add args: {path} attaches a SERVER folder at /folders/<name> (admin only; default read-only, pass {readOnly:"false"} for read-write, {name} overrides the mount name). ' +
    'add {kind:"pc"} connects a folder from the USER\'s OWN computer — the user picks it in the browser (returns a pick action; no path). ' +
    "remove detaches by itemId. Attaching/detaching a server folder restarts the sandbox.",
  requiredRole: "user", // list is visible to users (for pc folders); host add is gated inside
  auditNoun: "folder",
  // Host folders expose the operator's filesystem — the one checkpoint a
  // prompt-injected agent must never bypass, so keep add confirm-gated always.
  alwaysConfirm: true,
  addSchema,

  async canAdd(ctx) {
    const [host, pc] = await Promise.all([hostFolderEnabled(), pcFolderLevel()]);
    return (host && ctx.isAdmin) || canAttachPc(pc, ctx.isAdmin);
  },

  async list(ctx) {
    const [host, pc] = await Promise.all([hostFolderEnabled(), pcFolderLevel()]);
    if (!host && pc === "off") throw new Error("Folder access is turned off. An administrator can enable it in settings.");
    if (!ctx.sessionKey) throw new Error("No active workspace — open a chat to see attached folders.");
    const t = manageT(ctx.locale);
    const rows = await db.select().from(attachedFolders).where(eq(attachedFolders.sessionKey, ctx.sessionKey));
    return rows.map((f) => {
      // Host-folder subtitles carry the operator's real server path — only an admin
      // should ever see it (never a regular chat user, nor the model via them).
      const mode = f.readOnly ? loc(t, "folder.readOnly", "read-only") : loc(t, "folder.readWrite", "read-write");
      const subtitle = f.kind === "host"
        ? (ctx.isAdmin ? `${f.hostPath} · ${mode}` : mode)
        : loc(t, "folder.fromComputer", "from your computer");
      return { id: f.id, title: f.name, subtitle, owned: f.userId === ctx.userId };
    });
  },

  async validateAdd(ctx, args) {
    const a = args as AddArgs;
    const kind = a.kind ?? "host";
    if (kind === "host") {
      if (!(await hostFolderEnabled())) throw new Error("Server folder access is turned off. An administrator can enable it in settings.");
      if (!ctx.isAdmin) throw new Error("Server folders can only be attached by an administrator.");
      if (!a.path) throw new Error("A server folder path is required (an absolute path on the server, e.g. /srv/reports).");
      const v = await validateMount(a.path);
      if (!v.ok) throw new Error(mountError(v.code));
    } else {
      const level = await pcFolderLevel();
      if (!canAttachPc(level, ctx.isAdmin)) {
        throw new Error(level === "off"
          ? "Personal folder access is turned off. An administrator can enable it in settings."
          : "Connecting a personal folder is limited to administrators.");
      }
    }
    if (!ctx.sessionKey) throw new Error("No active workspace — open a chat to attach a folder.");
    const name = deriveName(a);
    if ((await names(ctx.sessionKey)).has(name)) {
      throw new Error(`A folder named "${name}" is already attached here — choose a different name.`);
    }
  },

  previewAdd(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    if ((a.kind ?? "host") === "pc") {
      return { title: loc(t, "folder.addPcTitle", "Connect a folder from your computer"), after: deriveName(a) };
    }
    const name = deriveName(a);
    const ro = a.readOnly !== "false";
    return {
      title: loc(t, "folder.addTitle", "Attach server folder"),
      after: `${a.path} → /folders/${name} (${ro ? "read-only" : "read-write"})`,
      impact: loc(t, "folder.restartImpact", "The sandbox will restart to attach the folder; any running command stops."),
    };
  },

  async add(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    const name = deriveName(a);
    // pc: don't create a row here — a pc folder with no picked handle is useless.
    // Hand the folder picker back to the browser (a button on the web card;
    // Telegram shows a "do it in the browser" note); the client POSTs
    // /api/folders once the user actually picks a directory.
    if ((a.kind ?? "host") === "pc") {
      return { itemTitle: name, action: { kind: "pick_folder", label: loc(t, "folder.pick", "Choose a folder") } };
    }
    // host: admin-only (enforced in validateAdd), read-only by default. Insert the
    // row, then recreate the sandbox so the mount goes live now.
    await db.insert(attachedFolders).values({
      id: randomUUID(),
      userId: ctx.userId,
      sessionKey: ctx.sessionKey!,
      kind: "host",
      name,
      hostPath: a.path!,
      readOnly: a.readOnly !== "false",
    });
    reattach(ctx);
    return { itemTitle: name };
  },

  async remove(ctx, itemId) {
    const [row] = await db.select().from(attachedFolders).where(eq(attachedFolders.id, itemId)).limit(1);
    if (!row || row.sessionKey !== ctx.sessionKey) throw new Error("No such folder.");
    if (row.kind === "host" && !ctx.isAdmin) throw new Error("Only an administrator can detach a server folder.");
    if (row.kind === "pc" && row.userId !== ctx.userId && !ctx.isAdmin) {
      throw new Error("Only the owner or an administrator can remove this folder.");
    }
    await db.delete(attachedFolders).where(eq(attachedFolders.id, itemId));
    // Host detach drops the mount via a recreate; pc detach only stops syncing —
    // the workspace copy stays (removing files is the user's explicit call).
    if (row.kind === "host") reattach(ctx);
    return { itemTitle: row.name };
  },
};
