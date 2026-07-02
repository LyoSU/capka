import { z } from "zod";
import { decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls, canInstallExtensions, assertCanInstall } from "@/lib/settings";
import { getPublicUrl } from "@/lib/url";
import {
  listServers,
  upsertServer,
  upsertStdioServer,
  deleteServer,
  setEnabled,
  getAccessibleServer,
} from "@/lib/mcp/service";
import { probeConfig, type ProbeStatus } from "@/lib/mcp/health";
import { hasUserTokens } from "@/lib/mcp/oauth/store";
import type { McpAuthKind, McpScope, McpSecrets } from "@/lib/mcp/types";
import { loc, manageT } from "../i18n";
import type { Collection, ManageContext, RequiredAction } from "../types";

const addSchema = z
  .object({
    name: z.string().min(1, "A connector name is required."),
    url: z.string().url("URL must be a valid https link.").optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    scope: z.enum(["user", "project", "org"]).optional(),
    authKind: z.enum(["oauth", "none"]).optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.command), {
    message: 'Provide EITHER "url" (a remote connector) OR "command" (a local stdio one).',
  });

type AddArgs = z.infer<typeof addSchema>;

/** Pure decision the add path turns into an authorization check. A stdio
 *  (local, runs in the sandbox) or an org-wide connector is admin-only; a
 *  personal remote connector is not. Extracted so the security-relevant choice
 *  is unit-tested without a DB. */
export function planMcpAdd(args: { scope?: string; command?: string }): {
  transport: "http" | "stdio";
  scope: McpScope;
  needsAdmin: boolean;
} {
  const transport = args.command ? "stdio" : "http";
  const scope: McpScope = args.scope === "org" ? "system" : (args.scope as McpScope) ?? "user";
  return { transport, scope, needsAdmin: scope === "system" || transport === "stdio" };
}

/** Authorization for adding a connector, shared by the dispatcher's confirm-phase
 *  pre-flight (`validateAdd`) and the apply-phase (`add`). Throws a friendly Error
 *  the caller surfaces verbatim. */
async function assertCanAddMcp(ctx: ManageContext, a: AddArgs): Promise<void> {
  const { needsAdmin } = planMcpAdd(a);
  if (needsAdmin && !ctx.isAdmin) {
    throw new Error("Local and shared (org) connectors can only be added by an administrator.");
  }
  await assertCanInstall(ctx.isAdmin, "connector");
}

/** Build the absolute OAuth sign-in URL the user's browser must open. Absolute
 *  (via the public origin) so it also works as a Telegram link, not just a web
 *  same-origin relative path. Labels localized to the caller's locale. */
function oauthAction(ctx: ManageContext, serverId: string): RequiredAction {
  const t = manageT(ctx.locale);
  return {
    kind: "oauth",
    url: `${getPublicUrl()}/api/mcp/oauth/start?serverId=${encodeURIComponent(serverId)}`,
    label: loc(t, "action.connect", "Connect"),
    description: loc(t, "action.oauthDesc", "Open the link to sign in and authorize this connector."),
  };
}

const PROBE_TO_STATE: Record<ProbeStatus, string> = {
  ok: "working",
  unauthorized: "unauthorized",
  unreachable: "unreachable",
  needs_login: "needs sign-in",
};

export const mcpCollection: Collection = {
  id: "mcp",
  title: "Connectors (MCP)",
  description: "External MCP connectors — add, enable/disable, debug, authorize.",
  requiredRole: "user",
  auditNoun: "connector",
  settingsPath: "/settings/skills?tab=connectors",
  addSchema,

  canAdd: (ctx) => canInstallExtensions(ctx.isAdmin),

  validateAdd: (ctx, args) => assertCanAddMcp(ctx, args as AddArgs),

  async list(ctx) {
    const t = manageT(ctx.locale);
    const servers = await listServers(ctx.userId, ctx.projectId);
    return Promise.all(servers.map(async (s) => ({
      id: s.id,
      title: s.name,
      subtitle: s.transport === "stdio" ? loc(t, "mcp.stdio", "local (stdio)") : s.url ?? undefined,
      enabled: s.enabled,
      // "sign-in needed" only when an OAuth connector actually lacks a token — once
      // the user has signed in it reads as a normal connector. (Was unconditional
      // for any OAuth connector, so a signed-in connector still showed "sign in".)
      status: s.authKind === "oauth" && !(await hasUserTokens(ctx.userId, s.id)) ? "oauth" : undefined,
      owned: s.mine,
    })));
  },

  async previewAdd(ctx, args) {
    const t = manageT(ctx.locale);
    const a = args as AddArgs;
    const { scope } = planMcpAdd(a);
    const preview: { title: string; after: string; impact?: string; details?: string } = {
      title: loc(t, "mcp.addTitle", "Add connector"),
      after: `${a.name}${a.url ? ` (${a.url})` : ` (${loc(t, "mcp.local", "local")})`}`,
      impact: scope === "system" ? loc(t, "mcp.sharedImpact", "Shared connector — available to all users.") : undefined,
    };
    // Probe-before-confirm: for a remote, non-OAuth connector, actually reach it
    // BEFORE the user confirms, so the card can say "responds, N tools" or warn
    // it's unreachable — instead of confirming blind. OAuth connectors expect an
    // unauthenticated probe to fail, so we just note the sign-in step. The probe
    // is advisory: any failure here must never block the add.
    if (a.url && a.authKind !== "oauth") {
      try {
        const health = await probeConfig({ name: a.name, url: a.url }, await getBlockPrivateProviderUrls(), { userId: ctx.userId });
        preview.details =
          health.status === "ok"
            ? loc(t, "mcp.probeOk", `Responds — ${health.toolCount ?? 0} tools available.`, { n: health.toolCount ?? 0 })
            : health.status === "unreachable"
              ? loc(t, "mcp.probeUnreachable", "Couldn't reach it just now — you can still add it and fix later.")
              : loc(t, "mcp.probeNeedsAuth", "Reachable, but it needs a sign-in or token (set on the settings page).");
      } catch {
        /* advisory only — never block the add on a probe error */
      }
    } else if (a.authKind === "oauth") {
      preview.details = loc(t, "mcp.probeOauth", "You'll sign in through your browser after adding it.");
    }
    return preview;
  },

  async add(ctx, args) {
    const a = args as AddArgs;
    await assertCanAddMcp(ctx, a); // defense-in-depth: dispatch pre-flights this too
    const { transport, scope } = planMcpAdd(a);
    const projectId = scope === "project" ? ctx.projectId : null;
    if (scope === "project" && !projectId) throw new Error("A project connector can only be added inside a project.");
    const userId = scope === "user" ? ctx.userId : scope === "project" ? ctx.userId : null;

    let id: string;
    if (transport === "stdio") {
      id = await upsertStdioServer({ scope, userId, projectId, name: a.name, command: a.command!, args: a.args });
    } else {
      id = await upsertServer({
        scope,
        userId,
        projectId,
        name: a.name,
        url: a.url!,
        authKind: a.authKind === "oauth" ? "oauth" : "token",
      });
    }
    return { itemTitle: a.name, action: a.authKind === "oauth" ? oauthAction(ctx, id) : undefined };
  },

  async remove(ctx, itemId) {
    const s = await mustManage(ctx, itemId);
    await deleteServer(itemId);
    return { itemTitle: s.name };
  },

  async setEnabled(ctx, itemId, enabled) {
    const s = await mustManage(ctx, itemId);
    await setEnabled(itemId, enabled);
    return { itemTitle: s.name };
  },

  async debug(ctx, itemId) {
    const t = manageT(ctx.locale);
    const s = await getAccessibleServer(ctx.userId, itemId);
    if (!s) throw new Error("No such connector.");
    if (s.transport !== "http" || !s.url) {
      return {
        itemTitle: s.name,
        state: loc(t, "state.local", "local"),
        hint: loc(t, "mcp.stdioHint", "Local (stdio) connectors are checked when the sandbox starts."),
      };
    }
    let secrets: McpSecrets | undefined;
    if (s.secrets) {
      try { secrets = JSON.parse(decrypt(s.secrets, await getMasterKey())) as McpSecrets; } catch { /* ignore */ }
    }
    const health = await probeConfig(
      { name: s.name, url: s.url, secrets, authKind: s.authKind as McpAuthKind, id: s.id },
      await getBlockPrivateProviderUrls(),
      { userId: ctx.userId },
    );
    const needsLogin = health.status === "needs_login" || health.status === "unauthorized";
    return {
      itemTitle: s.name,
      state: loc(t, `state.${health.status}`, PROBE_TO_STATE[health.status] ?? health.status),
      detail: health.detail ?? (health.status === "ok" ? loc(t, "mcp.toolCount", `${health.toolCount ?? 0} ${health.toolCount === 1 ? "tool" : "tools"}`, { n: health.toolCount ?? 0 }) : undefined),
      hint: needsLogin && s.authKind === "oauth" ? loc(t, "mcp.needsLoginHint", "Looks like it needs a fresh sign-in — authorize the connector.") : undefined,
      action: needsLogin && s.authKind === "oauth" ? oauthAction(ctx, s.id) : undefined,
    };
  },

  async connect(ctx, itemId) {
    const s = await getAccessibleServer(ctx.userId, itemId);
    if (!s) throw new Error("No such connector.");
    if (s.authKind !== "oauth") return null;
    return oauthAction(ctx, s.id);
  },
};

/** Ensure the caller may MUTATE this connector (stricter than "may use"): own a
 *  personal one, or be an admin for a shared/project one. Returns the row. */
async function mustManage(ctx: ManageContext, itemId: string) {
  const s = await getAccessibleServer(ctx.userId, itemId);
  if (!s) throw new Error("No such connector.");
  // The owner of a personal OR project-scoped connector may manage it — a member
  // can add a project connector (planMcpAdd allows scope:"project" for non-admins),
  // so they must be able to remove/toggle it too, not just admins.
  if ((s.scope === "user" || s.scope === "project") && s.userId === ctx.userId) return s;
  if (ctx.isAdmin) return s;
  throw new Error("Only the owner or an administrator can manage this connector.");
}
