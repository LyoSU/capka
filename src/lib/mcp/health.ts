import { and, eq, or, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
import { connectMcpServer, disconnectMcp } from "./client";
import { getConnectError } from "./connect-errors";
import { setCachedTools } from "./tool-cache";
import { McpOAuthProvider } from "./oauth/provider";
import { hasUserTokens } from "./oauth/store";
import { inferRemoteTransport, type McpAuthKind, type McpSecrets } from "./types";

/** A plain, non-jargon status the UI localizes into a friendly badge. */
export type ProbeStatus = "ok" | "unauthorized" | "unreachable" | "needs_login";
export interface ServerHealth {
  status: ProbeStatus;
  toolCount?: number;
  /** The server's own advertised name (MCP `initialize` → serverInfo.name), when the
   *  handshake succeeds. Used to auto-fill the connector name in the add form. */
  serverName?: string;
  /** Last connect error (e.g. the npx failure for a stdio server) — shown in the UI. */
  detail?: string;
}

const PROBE_CONCURRENCY = 4;
const CACHE_TTL_MS = 60_000;
// Keyed by `${id}:${updatedAtMs}` so an edit (new updatedAt) busts the entry.
const cache = new Map<string, { at: number; health: ServerHealth }>();

/** A 401/403 means the credential is wrong (fixable by the user); anything else
 *  (DNS, timeout, TLS, 5xx) is "can't reach it". The grok 401 carried `code: 401`
 *  and a "Bearer token" message — match both shapes. */
function classify(e: unknown): ProbeStatus {
  const err = e as { code?: number; message?: string } | undefined;
  const code = typeof err?.code === "number" ? err.code : undefined;
  const msg = (err?.message ?? "").toLowerCase();
  if (code === 401 || code === 403 || /\b(401|403|unauthorized|forbidden|bearer token|invalid token)\b/.test(msg)) {
    return "unauthorized";
  }
  return "unreachable";
}

/** Probe one decrypted config (bounded by connectMcpServer's own timeout).
 *  `auth` (userId + serverId) enables OAuth servers to probe with the user's
 *  stored token; without a token an OAuth server reports `needs_login`. */
export async function probeConfig(
  cfg: {
    name: string;
    url: string;
    secrets?: McpSecrets;
    authKind?: McpAuthKind;
    id?: string;
    /** Omit to read the protocol off the URL — the add form probes before a row exists. */
    transport?: "http" | "sse";
  },
  blockPrivate: boolean,
  auth?: { userId: string },
): Promise<ServerHealth> {
  let authProvider: McpOAuthProvider | undefined;
  if (cfg.authKind === "oauth" && cfg.id && auth) {
    if (!(await hasUserTokens(auth.userId, cfg.id))) return { status: "needs_login" };
    authProvider = new McpOAuthProvider(auth.userId, cfg.id, "runtime");
  }
  let connected;
  try {
    connected = await connectMcpServer(
      { name: cfg.name, transport: cfg.transport ?? inferRemoteTransport(cfg.url), url: cfg.url, secrets: cfg.secrets },
      { blockPrivate, authProvider },
    );
  } catch (e) {
    return { status: classify(e) };
  }
  try {
    // Connectors are declared from the schema cache and dialled lazily, so seed it
    // here: this probe already paid for the handshake, and it means a connector the
    // admin just saved contributes its tools to the very first turn instead of
    // waiting a turn for a background warm. Only for a STORED row — the add form
    // probes before one exists, under a placeholder name that must not become a
    // cache key (the runtime looks the cache up by `id ?? name`).
    if (cfg.id) setCachedTools(cfg.id, connected.tools);
    // The handshake recorded the server's serverInfo; surface its name so the add
    // form can auto-fill the connector name instead of leaving it blank.
    const serverName = connected.client.getServerVersion()?.name;
    return { status: "ok", toolCount: connected.tools.length, ...(serverName ? { serverName } : {}) };
  } finally {
    await disconnectMcp(connected).catch(() => {});
  }
}

/** Health for every enabled connector visible to this user (own user-scope +
 *  org system). Probed in parallel (bounded), cached ~60s per (id, updatedAt). */
export async function probeUserServers(userId: string): Promise<Record<string, ServerHealth>> {
  const rows = await db
    .select().from(mcpServers)
    .where(and(
      eq(mcpServers.enabled, true),
      or(and(eq(mcpServers.userId, userId), isNull(mcpServers.projectId)), eq(mcpServers.scope, "system")),
    ));
  // Both remote protocols are probeable over the network; only stdio isn't.
  const remoteRows = rows.filter((r) => (r.transport === "http" || r.transport === "sse") && r.url);
  const key = await getMasterKey();
  const blockPrivate = await getBlockPrivateProviderUrls();
  const now = Date.now();
  // Bound the map before reading it. The key carries `updatedAt`, so every edit of a
  // connector mints a fresh key and abandons the old one, and an uninstalled
  // connector is never looked up again — nothing else evicts either, so entries
  // accumulated for the life of the process. Anything past the TTL is already a miss,
  // so this changes no outcome: the map holds what is still servable rather than
  // every (connector, revision) the process has ever probed.
  for (const [k, hit] of cache) if (now - hit.at >= CACHE_TTL_MS) cache.delete(k);
  const out: Record<string, ServerHealth> = {};

  // stdio servers can't be probed here (they need a live sandbox session), but if a
  // recent run recorded a connect failure, surface it so the UI explains the silence.
  for (const r of rows.filter((r) => r.transport === "stdio")) {
    const detail = getConnectError(userId, r.id);
    if (detail) out[r.id] = { status: "unreachable", detail };
  }

  // Split into cache hits vs rows needing a live probe.
  const toProbe: { id: string; cacheKey: string; name: string; url: string; secrets?: McpSecrets; authKind: McpAuthKind; transport: "http" | "sse" }[] = [];
  for (const r of remoteRows) {
    const cacheKey = `${r.id}:${r.updatedAt?.getTime() ?? 0}`;
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) { out[r.id] = hit.health; continue; }
    let secrets: McpSecrets | undefined;
    if (r.secrets) { try { secrets = JSON.parse(decrypt(r.secrets, key)) as McpSecrets; } catch { secrets = undefined; } }
    toProbe.push({
      id: r.id, cacheKey, name: r.name, url: r.url!, secrets,
      authKind: r.authKind as McpAuthKind,
      transport: r.transport === "sse" ? "sse" : "http",
    });
  }

  for (let i = 0; i < toProbe.length; i += PROBE_CONCURRENCY) {
    const batch = toProbe.slice(i, i + PROBE_CONCURRENCY);
    const settled = await Promise.all(batch.map((p) => probeConfig(p, blockPrivate, { userId })));
    settled.forEach((health, idx) => {
      const p = batch[idx];
      // Don't cache `needs_login` — it flips to `ok` the moment the user signs in,
      // and recomputing it is just a token-presence check.
      if (health.status !== "needs_login") cache.set(p.cacheKey, { at: Date.now(), health });
      out[p.id] = health;
    });
  }

  // Surface a recorded sign-in/connect failure (e.g. an OAuth server that doesn't
  // support dynamic client registration) as the detail — so the user sees WHY a
  // connector won't authorize instead of a silent "needs sign-in". Any transport;
  // a healthy probe always wins (a recorded error is only the last FAILED attempt).
  for (const r of rows) {
    if (out[r.id]?.status === "ok") continue;
    const detail = getConnectError(userId, r.id);
    if (detail) out[r.id] = { ...(out[r.id] ?? { status: "unreachable" }), detail };
  }
  return out;
}
