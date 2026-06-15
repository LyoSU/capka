import { and, eq, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { mcpOauthClients, mcpOauthTokens, mcpOauthStates } from "@/lib/db/schema";
import { encrypt, decrypt } from "@/lib/crypto";
import { getMasterKey } from "@/lib/settings";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** In-flight authorizations older than this are stale and rejected. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

// ── DCR client (per server, shared) ──────────────────────────────────────────

export async function getClientInfo(serverId: string): Promise<OAuthClientInformationFull | undefined> {
  const row = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.serverId, serverId)).limit(1);
  if (!row[0]) return undefined;
  try { return JSON.parse(decrypt(row[0].clientInfo, await getMasterKey())) as OAuthClientInformationFull; }
  catch { return undefined; }
}

export async function saveClientInfo(serverId: string, info: OAuthClientInformationFull): Promise<void> {
  const clientInfo = encrypt(JSON.stringify(info), await getMasterKey());
  await db.insert(mcpOauthClients).values({ serverId, clientInfo })
    .onConflictDoUpdate({ target: mcpOauthClients.serverId, set: { clientInfo } });
}

// ── Per-user tokens ───────────────────────────────────────────────────────────

export async function getUserTokens(userId: string, serverId: string): Promise<OAuthTokens | undefined> {
  const row = await db.select().from(mcpOauthTokens)
    .where(and(eq(mcpOauthTokens.userId, userId), eq(mcpOauthTokens.serverId, serverId))).limit(1);
  if (!row[0]) return undefined;
  try { return JSON.parse(decrypt(row[0].tokens, await getMasterKey())) as OAuthTokens; }
  catch { return undefined; }
}

export async function hasUserTokens(userId: string, serverId: string): Promise<boolean> {
  const row = await db.select({ id: mcpOauthTokens.id }).from(mcpOauthTokens)
    .where(and(eq(mcpOauthTokens.userId, userId), eq(mcpOauthTokens.serverId, serverId))).limit(1);
  return !!row[0];
}

export async function saveUserTokens(userId: string, serverId: string, tokens: OAuthTokens, account?: string): Promise<void> {
  const enc = encrypt(JSON.stringify(tokens), await getMasterKey());
  const existing = await db.select({ id: mcpOauthTokens.id }).from(mcpOauthTokens)
    .where(and(eq(mcpOauthTokens.userId, userId), eq(mcpOauthTokens.serverId, serverId))).limit(1);
  if (existing[0]) {
    await db.update(mcpOauthTokens).set({ tokens: enc, ...(account ? { account } : {}), updatedAt: new Date() })
      .where(eq(mcpOauthTokens.id, existing[0].id));
  } else {
    await db.insert(mcpOauthTokens).values({ id: nanoid(), userId, serverId, tokens: enc, account: account ?? null });
  }
}

export async function deleteUserTokens(userId: string, serverId: string): Promise<void> {
  await db.delete(mcpOauthTokens)
    .where(and(eq(mcpOauthTokens.userId, userId), eq(mcpOauthTokens.serverId, serverId)));
}

// ── In-flight state (PKCE verifier), single-use + TTL ────────────────────────

export async function insertState(state: string, userId: string, serverId: string, codeVerifier: string): Promise<void> {
  const enc = encrypt(codeVerifier, await getMasterKey());
  await db.insert(mcpOauthStates).values({ state, userId, serverId, codeVerifier: enc });
}

/** Consume a state: return its payload if valid + fresh, then delete it. Also
 *  sweeps expired rows. Returns null for unknown/expired/used states. */
export async function consumeState(state: string): Promise<{ userId: string; serverId: string; codeVerifier: string } | null> {
  await db.delete(mcpOauthStates).where(lt(mcpOauthStates.createdAt, new Date(Date.now() - OAUTH_STATE_TTL_MS)));
  const row = await db.select().from(mcpOauthStates).where(eq(mcpOauthStates.state, state)).limit(1);
  if (!row[0]) return null;
  await db.delete(mcpOauthStates).where(eq(mcpOauthStates.state, state));
  if (Date.now() - (row[0].createdAt?.getTime() ?? 0) > OAUTH_STATE_TTL_MS) return null;
  let codeVerifier: string;
  try { codeVerifier = decrypt(row[0].codeVerifier, await getMasterKey()); } catch { return null; }
  return { userId: row[0].userId, serverId: row[0].serverId, codeVerifier };
}
