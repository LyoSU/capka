import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { mcpServers, projects } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
import { assertSafeUrl } from "@/lib/net/ssrf";
import { ValidationError } from "@/lib/errors";
import type { McpAuthKind, McpScope, McpSecrets, McpServerConfig, McpServerInfo } from "./types";

const SCOPE_RANK: Record<McpScope, number> = { system: 0, user: 1, project: 2 };
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The connector name doubles as the tool namespace (`mcp__<name>__<tool>`), so it
 * must be slug-safe. Rather than reject a human-typed name ("My Notion", "Grok"),
 * normalize it: lowercase, non-alphanumeric runs → single hyphen, trimmed, capped.
 * "My Notion" → "my-notion", "Grok" → "grok". Empty result (e.g. only symbols) is
 * the only invalid case and surfaces as a friendly 400.
 */
export function slugifyName(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function toInfo(r: typeof mcpServers.$inferSelect): McpServerInfo {
  return { id: r.id, scope: r.scope as McpScope, name: r.name, transport: r.transport as McpServerInfo["transport"], url: r.url, enabled: r.enabled, authKind: r.authKind as McpAuthKind };
}

export function dedupeServersByPrecedence(list: McpServerInfo[]): McpServerInfo[] {
  const byName = new Map<string, McpServerInfo>();
  for (const item of list) {
    const cur = byName.get(item.name);
    if (!cur || SCOPE_RANK[item.scope] > SCOPE_RANK[cur.scope]) byName.set(item.name, item);
  }
  return [...byName.values()];
}

/** Enabled servers visible to this run, with decrypted config (for load.ts). */
export async function listEnabledServerConfigs(userId: string, projectId?: string | null): Promise<McpServerConfig[]> {
  const filter = projectId
    ? or(
        eq(mcpServers.scope, "system"),
        and(eq(mcpServers.scope, "user"), eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
        and(eq(mcpServers.scope, "project"), eq(mcpServers.projectId, projectId)),
      )
    : or(
        eq(mcpServers.scope, "system"),
        and(eq(mcpServers.scope, "user"), eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
      );
  const rows = await db.select().from(mcpServers).where(and(eq(mcpServers.enabled, true), filter));
  const winners = dedupeServersByPrecedence(rows.map(toInfo));
  const winnerIds = new Set(winners.map((w) => w.id));
  const key = await getMasterKey();
  const out: McpServerConfig[] = [];
  for (const r of rows) {
    if (!winnerIds.has(r.id) || r.transport !== "http" || !r.url) continue;
    let secrets: McpSecrets | undefined;
    if (r.secrets) {
      try { secrets = JSON.parse(decrypt(r.secrets, key)) as McpSecrets; } catch { secrets = undefined; }
    }
    out.push({ id: r.id, name: r.name, transport: "http", url: r.url, secrets, authKind: r.authKind as McpAuthKind });
  }
  return out;
}

/**
 * For the UI/API — no secrets. Scoped exactly like listEnabledServerConfigs so a
 * caller can never see another scope's rows: own `user` connectors (projectId
 * null) + org `system` connectors, plus the named project's connectors ONLY when
 * a projectId is given. NOTE: callers passing a projectId from the request MUST
 * first assert the user belongs to that project (defense-in-depth; the query no
 * longer leaks project rows by id alone).
 */
export async function listServers(userId: string, projectId?: string | null): Promise<McpServerInfo[]> {
  const rows = await db
    .select().from(mcpServers)
    .where(projectId
      ? or(
          and(eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
          eq(mcpServers.scope, "system"),
          and(eq(mcpServers.scope, "project"), eq(mcpServers.projectId, projectId)),
        )
      : or(
          and(eq(mcpServers.userId, userId), isNull(mcpServers.projectId)),
          eq(mcpServers.scope, "system"),
        ));
  return rows.map(toInfo);
}

export interface UpsertServerInput {
  id?: string;
  scope: McpScope;
  userId: string | null;
  projectId: string | null;
  name: string;
  url: string;
  secrets?: McpSecrets;
  authKind?: McpAuthKind;
  source?: string; // 'manual' | 'catalog:<installId>'
}

export async function upsertServer(input: UpsertServerInput): Promise<string> {
  const name = slugifyName(input.name);
  if (!NAME_RE.test(name)) throw new ValidationError("Use letters or numbers in the connector name.");
  try {
    await assertSafeUrl(input.url, await getBlockPrivateProviderUrls());
  } catch (e) {
    // assertSafeUrl already produces friendly, non-jargon messages — surface as 400.
    throw new ValidationError(e instanceof Error ? e.message : "That URL can't be used.");
  }
  const key = await getMasterKey();
  const id = input.id ?? nanoid();
  const values = {
    id, scope: input.scope, userId: input.userId, projectId: input.projectId,
    name, transport: "http" as const, url: input.url,
    secrets: input.secrets ? encrypt(JSON.stringify(input.secrets), key) : null,
    ...(input.authKind ? { authKind: input.authKind } : {}),
    ...(input.source ? { source: input.source } : {}),
    updatedAt: new Date(),
  };
  const existing = input.id
    ? await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, input.id)).limit(1)
    : [];
  if (existing[0]) await db.update(mcpServers).set(values).where(eq(mcpServers.id, id));
  else await db.insert(mcpServers).values(values);
  return id;
}

/** Return the server row IFF this user may use it (own user-scope, any system,
 *  or a project they own). Used to gate the OAuth sign-in flow. */
export async function getAccessibleServer(userId: string, serverId: string) {
  const row = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).limit(1);
  const s = row[0];
  if (!s) return null;
  if (s.scope === "system") return s;
  if (s.scope === "user" && s.userId === userId) return s;
  if (s.scope === "project" && s.projectId) {
    const p = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, s.projectId), eq(projects.userId, userId))).limit(1);
    if (p[0]) return s;
  }
  return null;
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await db.update(mcpServers).set({ enabled, updatedAt: new Date() }).where(eq(mcpServers.id, id));
}

export async function deleteServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}
