import { z } from "zod";
import { decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
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
import type { McpAuthKind, McpScope, McpSecrets } from "@/lib/mcp/types";
import type { Collection, ManageContext, RequiredAction } from "../types";

const addSchema = z
  .object({
    name: z.string().min(1, "Потрібна назва конектора."),
    url: z.string().url("URL має бути коректним https-посиланням.").optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    scope: z.enum(["user", "project", "org"]).optional(),
    authKind: z.enum(["oauth", "none"]).optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.command), {
    message: 'Вкажіть АБО "url" (віддалений конектор), АБО "command" (локальний stdio).',
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

/** Build the absolute OAuth sign-in URL the user's browser must open. Absolute
 *  (via the public origin) so it also works as a Telegram link, not just a web
 *  same-origin relative path. */
function oauthAction(serverId: string): RequiredAction {
  return {
    kind: "oauth",
    url: `${getPublicUrl()}/api/mcp/oauth/start?serverId=${encodeURIComponent(serverId)}`,
    label: "Підключити",
    description: "Відкрийте посилання, щоб увійти й авторизувати цей конектор.",
  };
}

const PROBE_TO_STATE: Record<ProbeStatus, string> = {
  ok: "працює",
  unauthorized: "не авторизовано",
  unreachable: "недоступний",
  needs_login: "потрібен вхід",
};

export const mcpCollection: Collection = {
  id: "mcp",
  title: "Конектори (MCP)",
  description: "Зовнішні MCP-конектори — додати, увімкнути/вимкнути, діагностувати, авторизувати.",
  requiredRole: "user",
  addSchema,

  async list(ctx) {
    const servers = await listServers(ctx.userId, ctx.projectId);
    return servers.map((s) => ({
      id: s.id,
      title: s.name,
      subtitle: s.transport === "stdio" ? "локальний (stdio)" : s.url ?? undefined,
      enabled: s.enabled,
      status: s.authKind === "oauth" ? "oauth" : undefined,
      owned: s.mine,
    }));
  },

  previewAdd(_ctx, args) {
    const a = args as AddArgs;
    const { scope } = planMcpAdd(a);
    return {
      title: "Додати конектор",
      after: `${a.name}${a.url ? ` (${a.url})` : " (локальний)"}`,
      impact: scope === "system" ? "Спільний конектор — стане доступним усім користувачам." : undefined,
    };
  },

  async add(ctx, args) {
    const a = args as AddArgs;
    const { transport, scope, needsAdmin } = planMcpAdd(a);
    if (needsAdmin && !ctx.isAdmin) {
      throw new Error("Локальні та спільні (org) конектори може додавати лише адміністратор.");
    }
    const projectId = scope === "project" ? ctx.projectId : null;
    if (scope === "project" && !projectId) throw new Error("Проєктний конектор можна додати лише всередині проєкту.");
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
    return { itemTitle: a.name, action: a.authKind === "oauth" ? oauthAction(id) : undefined };
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
    const s = await getAccessibleServer(ctx.userId, itemId);
    if (!s) throw new Error("Немає такого конектора.");
    if (s.transport !== "http" || !s.url) {
      return { itemTitle: s.name, state: "локальний", hint: "Локальні (stdio) конектори перевіряються під час запуску пісочниці." };
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
      state: PROBE_TO_STATE[health.status] ?? health.status,
      detail: health.detail ?? (health.status === "ok" ? `${health.toolCount ?? 0} інструментів` : undefined),
      hint: needsLogin && s.authKind === "oauth" ? "Схоже, потрібен повторний вхід — авторизуйте конектор." : undefined,
      action: needsLogin && s.authKind === "oauth" ? oauthAction(s.id) : undefined,
    };
  },

  async connect(ctx, itemId) {
    const s = await getAccessibleServer(ctx.userId, itemId);
    if (!s) throw new Error("Немає такого конектора.");
    if (s.authKind !== "oauth") return null;
    return oauthAction(s.id);
  },
};

/** Ensure the caller may MUTATE this connector (stricter than "may use"): own a
 *  personal one, or be an admin for a shared/project one. Returns the row. */
async function mustManage(ctx: ManageContext, itemId: string) {
  const s = await getAccessibleServer(ctx.userId, itemId);
  if (!s) throw new Error("Немає такого конектора.");
  if (s.scope === "user" && s.userId === ctx.userId) return s;
  if (ctx.isAdmin) return s;
  throw new Error("Керувати цим конектором може лише його власник або адміністратор.");
}
