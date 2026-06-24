import type { Tool } from "ai";
import { getBlockPrivateProviderUrls } from "@/lib/settings";
import { connectMcpServer, disconnectMcp, type ConnectedMcp } from "./client";
import { adaptMcpTool, mcpToolName } from "./adapt";
import { listEnabledServerConfigs } from "./service";
import { recordConnectError, clearConnectError } from "./connect-errors";
import { McpOAuthProvider } from "./oauth/provider";
import { needsPluginRoot, resolvePluginRoot } from "./plugin-runtime";

const MAX_CONCURRENT = 4;

/** Connect every enabled server (bounded concurrency), adapt + namespace their
 *  tools. A server that fails is logged and skipped — never fatal. Tools are
 *  collected in deterministic order (servers by name, tools by name) so the
 *  position-0 tool prefix stays cache-stable. */
export async function loadMcpTools(opts: {
  userId: string;
  projectId: string | null;
  /** The run's sandbox session — required to bridge stdio connectors. */
  sessionKey?: string;
  /** Shared, memoized session creator. A stdio connector runs via `docker exec`
   *  inside the sandbox, so the container must exist before we connect — call this
   *  first. http/sse connectors don't need it, keeping the sandbox lazy. */
  ensureSession?: () => Promise<unknown>;
  /** Governance gate — a denied connector is never connected (G1). */
  isServerAllowed?: (name: string) => boolean;
}): Promise<{
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}> {
  const allow = opts.isServerAllowed ?? (() => true);
  const configs = (await listEnabledServerConfigs(opts.userId, opts.projectId))
    .filter((c) => allow(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Any stdio connector needs a live container (its server is `docker exec`'d in,
  // and a plugin's files are materialized via exec). Spin it up once, up front,
  // with the run's networkMode — otherwise the connect/materialize calls below
  // would hit a not-yet-created session (404) and the connector would be skipped.
  if (opts.ensureSession && configs.some((c) => c.transport === "stdio")) {
    await opts.ensureSession().catch((e) => {
      console.warn("[mcp] ensureSession failed; stdio connectors will be skipped:", e instanceof Error ? e.message : e);
    });
  }
  // Same SSRF policy the connector URL was validated against at upsert time.
  const blockPrivate = await getBlockPrivateProviderUrls();
  const connected: ConnectedMcp[] = [];
  const tools: Record<string, Tool> = {};

  for (let i = 0; i < configs.length; i += MAX_CONCURRENT) {
    const batch = configs.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.allSettled(batch.map(async (c) => {
      // OAuth connectors use this user's stored tokens (auto-refresh, never
      // redirects mid-run); a missing token throws → the server is skipped and
      // the UI prompts the user to sign in.
      const authProvider = c.authKind === "oauth" && c.id
        ? new McpOAuthProvider(opts.userId, c.id, "runtime")
        : undefined;
      // A plugin's bundled stdio server: materialize its files into the sandbox
      // and resolve ${CLAUDE_PLUGIN_ROOT} before connecting.
      const cfg = opts.sessionKey && needsPluginRoot(c)
        ? await resolvePluginRoot(opts.sessionKey, c)
        : c;
      return connectMcpServer(cfg, { blockPrivate, authProvider, sessionKey: opts.sessionKey });
    }));
    settled.forEach((r, idx) => {
      const cfg = batch[idx];
      if (r.status === "rejected") {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[mcp] connect failed for "${cfg.name}":`, reason);
        recordConnectError(cfg.id, reason);
        return;
      }
      clearConnectError(cfg.id);
      connected.push(r.value);
      for (const mt of [...r.value.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        tools[mcpToolName(cfg.name, mt.name)] = adaptMcpTool(r.value.client, cfg.name, mt);
      }
    });
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(connected.map(disconnectMcp));
    },
  };
}
