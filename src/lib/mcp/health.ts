import { and, eq, or, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
import { connectMcpServer, disconnectMcp } from "./client";
import { McpOAuthProvider } from "./oauth/provider";
import { hasUserTokens } from "./oauth/store";
import type { McpAuthKind, McpSecrets } from "./types";

/** A plain, non-jargon status the UI localizes into a friendly badge. */
export type ProbeStatus = "ok" | "unauthorized" | "unreachable" | "needs_login";
export interface ServerHealth {
  status: ProbeStatus;
  toolCount?: number;
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
  cfg: { name: string; url: string; secrets?: McpSecrets; authKind?: McpAuthKind; id?: string },
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
    connected = await connectMcpServer({ name: cfg.name, transport: "http", url: cfg.url, secrets: cfg.secrets }, { blockPrivate, authProvider });
  } catch (e) {
    return { status: classify(e) };
  }
  try {
    return { status: "ok", toolCount: connected.tools.length };
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
  const httpRows = rows.filter((r) => r.transport === "http" && r.url);
  const key = await getMasterKey();
  const blockPrivate = await getBlockPrivateProviderUrls();
  const now = Date.now();
  const out: Record<string, ServerHealth> = {};

  // Split into cache hits vs rows needing a live probe.
  const toProbe: { id: string; cacheKey: string; name: string; url: string; secrets?: McpSecrets; authKind: McpAuthKind }[] = [];
  for (const r of httpRows) {
    const cacheKey = `${r.id}:${r.updatedAt?.getTime() ?? 0}`;
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) { out[r.id] = hit.health; continue; }
    let secrets: McpSecrets | undefined;
    if (r.secrets) { try { secrets = JSON.parse(decrypt(r.secrets, key)) as McpSecrets; } catch { secrets = undefined; } }
    toProbe.push({ id: r.id, cacheKey, name: r.name, url: r.url!, secrets, authKind: r.authKind as McpAuthKind });
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
  return out;
}
