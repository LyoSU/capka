import { and, eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { mcpServers, projects } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getMasterKey, getBlockPrivateProviderUrls } from "@/lib/settings";
import { assertSafeUrl } from "@/lib/net/ssrf";
import { ValidationError } from "@/lib/errors";
import { mutedIds } from "@/lib/muted-resources";
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
  const allRows = await db.select().from(mcpServers).where(and(eq(mcpServers.enabled, true), filter));
  // Runtime enforcement of the per-user opt-out: a shared connector this user
  // muted never connects (only shared ids are ever muted, so own rows are safe).
  const muted = await mutedIds(userId, "mcp");
  const rows = allRows.filter((r) => !muted.has(r.id));
  const winners = dedupeServersByPrecedence(rows.map(toInfo));
  const winnerIds = new Set(winners.map((w) => w.id));
  const key = await getMasterKey();
  const out: McpServerConfig[] = [];
  for (const r of rows) {
    if (!winnerIds.has(r.id)) continue;
    const isHttp = r.transport === "http" && r.url;
    const isStdio = r.transport === "stdio" && r.command;
    if (!isHttp && !isStdio) continue; // sse not served yet
    let secrets: McpSecrets | undefined;
    if (r.secrets) {
      try { secrets = JSON.parse(decrypt(r.secrets, key)) as McpSecrets; } catch { secrets = undefined; }
    }
    out.push({
      id: r.id,
      name: r.name,
      transport: r.transport as McpServerConfig["transport"],
      url: r.url ?? "",
      command: r.command ?? undefined,
      args: (r.args as string[] | null) ?? undefined,
      secrets,
      authKind: r.authKind as McpAuthKind,
      source: r.source,
    });
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
  // Effective per-user state: a shared connector the user muted shows as off
  // (and `mine` lets the UI choose a global toggle vs a personal mute).
  const muted = await mutedIds(userId, "mcp");
  return rows
    // Plugin-installed connectors are managed on the Extensions tab; the Connectors
    // list shows only hand-added ones so nothing appears in two places.
    .filter((r) => !r.source.startsWith("catalog:"))
    .map((r) => {
      const info = toInfo(r);
      const mine = r.scope === "user";
      return { ...info, mine, enabled: mine ? info.enabled : info.enabled && !muted.has(r.id) };
    });
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

/** Id of an existing row with the same identity (explicit id, else scope + name +
 *  source within the same owner/project) so upserts dedupe in place — re-applying a
 *  plugin updates its own row. Crucially `source` is part of the key: a plugin
 *  (`catalog:<id>`) must NOT match, and thus overwrite, a same-named MANUAL row.
 *  `name` must already be slugified. */
async function existingServerId(input: { id?: string; scope: McpScope; userId: string | null; projectId: string | null; name: string; source?: string }): Promise<string | undefined> {
  const rows = await db.select({ id: mcpServers.id }).from(mcpServers).where(
    input.id
      ? eq(mcpServers.id, input.id)
      : and(
          eq(mcpServers.scope, input.scope),
          input.userId ? eq(mcpServers.userId, input.userId) : isNull(mcpServers.userId),
          input.projectId ? eq(mcpServers.projectId, input.projectId) : isNull(mcpServers.projectId),
          eq(mcpServers.name, input.name),
          eq(mcpServers.source, input.source ?? "manual"),
        ),
  ).limit(1);
  return rows[0]?.id;
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
  const matchedId = await existingServerId({ id: input.id, scope: input.scope, userId: input.userId, projectId: input.projectId, name, source: input.source });
  const id = matchedId ?? nanoid();
  const values = {
    id, scope: input.scope, userId: input.userId, projectId: input.projectId,
    name, transport: "http" as const, url: input.url,
    secrets: input.secrets ? encrypt(JSON.stringify(input.secrets), key) : null,
    ...(input.authKind ? { authKind: input.authKind } : {}),
    ...(input.source ? { source: input.source } : {}),
    updatedAt: new Date(),
  };
  if (matchedId) await db.update(mcpServers).set(values).where(eq(mcpServers.id, id));
  else await db.insert(mcpServers).values(values);
  return id;
}

export interface UpsertStdioInput {
  id?: string;
  scope: McpScope;
  userId: string | null;
  projectId: string | null;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  source?: string;
}

/**
 * Create/update a stdio MCP server (command + args + env). The process runs inside
 * the session sandbox at run time (see load.ts), never on the host — so there's no
 * URL and no SSRF check; the trust boundary is the sandbox. Admin-only at the route.
 */
export async function upsertStdioServer(input: UpsertStdioInput): Promise<string> {
  const name = slugifyName(input.name);
  if (!NAME_RE.test(name)) throw new ValidationError("Use letters or numbers in the connector name.");
  if (!input.command.trim()) throw new ValidationError("A command is required for a local connector.");
  const key = await getMasterKey();
  const matchedId = await existingServerId({ id: input.id, scope: input.scope, userId: input.userId, projectId: input.projectId, name, source: input.source });
  const id = matchedId ?? nanoid();
  const values = {
    id, scope: input.scope, userId: input.userId, projectId: input.projectId,
    name, transport: "stdio" as const, url: null,
    command: input.command.trim(),
    args: input.args ?? [],
    secrets: input.env && Object.keys(input.env).length ? encrypt(JSON.stringify({ env: input.env } satisfies McpSecrets), key) : null,
    authKind: "token" as const,
    ...(input.source ? { source: input.source } : {}),
    updatedAt: new Date(),
  };
  if (matchedId) await db.update(mcpServers).set(values).where(eq(mcpServers.id, id));
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

/** Scope + display name of a connector by id, or null if it doesn't exist. Lets
 *  the admin route refuse (404) to manage a member's PERSONAL (`user`-scope)
 *  connector, mirroring the skills route's getSkillMeta scope guard, and gives the
 *  audit log the human name instead of the opaque id. */
export async function getServerMeta(id: string): Promise<{ scope: McpScope; name: string } | null> {
  const row = (await db.select({ scope: mcpServers.scope, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, id)).limit(1))[0];
  return row ? { scope: row.scope as McpScope, name: row.name } : null;
}

/** True if a real project with this id exists — the admin connector route trusts a
 *  projectId from the request body, so it must verify the target before attaching a
 *  connector (with secret headers/env) to it. */
export async function projectExists(projectId: string): Promise<boolean> {
  const row = (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  return !!row;
}
