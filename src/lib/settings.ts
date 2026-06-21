import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./db/schema";
import { encrypt, decrypt, generateSecret } from "./crypto";
import { checkMasterKey, CANARY_PLAINTEXT } from "./master-key";

let masterKeyCache: string | null = null;

export async function getMasterKey(): Promise<string> {
  // Root of trust: prefer an explicit env/secret outside the DB. Encrypting
  // provider keys with a key stored in the same DB gives ~zero protection
  // against a DB leak, so production must set UNCLAW_MASTER_KEY.
  const envKey = process.env.UNCLAW_MASTER_KEY?.trim();
  if (envKey) {
    masterKeyCache = envKey;
    return envKey;
  }

  if (masterKeyCache) return masterKeyCache;

  const row = await db.select().from(settings).where(eq(settings.key, "auth_secret")).limit(1);

  if (row[0]) {
    masterKeyCache = row[0].value;
    return masterKeyCache;
  }

  console.warn(
    "[security] UNCLAW_MASTER_KEY is not set — generating a master key and storing it in the DB. " +
    "This is insecure (a DB leak exposes all provider keys). Set UNCLAW_MASTER_KEY in production.",
  );
  const secret = generateSecret();
  await db.insert(settings).values({ key: "auth_secret", value: secret, isEncrypted: false });
  masterKeyCache = secret;
  return secret;
}

/**
 * Where the master key lives, for the admin security banner.
 * - "env":  UNCLAW_MASTER_KEY is set (the secure root of trust, outside the DB).
 * - "db":   no env var; the key is stored PLAINTEXT in the DB — a DB leak exposes
 *           every provider key. `dbKey` is returned so an admin can copy the SAME
 *           value into the env (changing it would break decryption + all sessions).
 * - "none": no key persisted yet (pre-setup).
 *
 * `dbKeyPresent` flags a leftover DB copy even when env is set, so the banner can
 * offer to clean it up — otherwise a DB dump still leaks the key.
 */
export async function getMasterKeyStatus(): Promise<{
  source: "env" | "db" | "none";
  dbKeyPresent: boolean;
  dbKey: string | null;
}> {
  const envKey = process.env.UNCLAW_MASTER_KEY?.trim();
  const row = await db.select().from(settings).where(eq(settings.key, "auth_secret")).limit(1);
  const dbKey = row[0]?.value ?? null;
  if (envKey) return { source: "env", dbKeyPresent: !!dbKey, dbKey: null };
  if (dbKey) return { source: "db", dbKeyPresent: true, dbKey };
  return { source: "none", dbKeyPresent: false, dbKey: null };
}

/** Delete the DB-stored master key. Caller MUST verify the env key is set first,
 *  or the next getMasterKey() would mint a new one and orphan all encrypted data. */
export async function removeStoredMasterKey(): Promise<void> {
  await db.delete(settings).where(eq(settings.key, "auth_secret"));
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row[0]) return null;

  if (row[0].isEncrypted) {
    const masterKey = await getMasterKey();
    return decrypt(row[0].value, masterKey);
  }

  return row[0].value;
}

export async function setSetting(key: string, value: string, encrypted = false): Promise<void> {
  const storedValue = encrypted ? encrypt(value, await getMasterKey()) : value;

  await db.insert(settings)
    .values({ key, value: storedValue, isEncrypted: encrypted })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: storedValue, isEncrypted: encrypted, updatedAt: new Date() },
    });
}

/**
 * Boot-time guard: confirm the active master key still matches the data
 * encrypted at rest. On first run there's no canary yet, so we establish one
 * (Key Check Value). On a mismatch we throw with an actionable message — far
 * better than letting every provider-key decryption fail with a cryptic GCM
 * error later. The canary row is read raw (not via getSetting) so a wrong key
 * surfaces here as a controlled mismatch rather than a thrown decrypt.
 */
export async function assertMasterKeyConsistent(): Promise<void> {
  const key = await getMasterKey();
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "master_key_check"))
    .limit(1);

  const result = checkMasterKey(row[0]?.value ?? null, key);
  if (result.status === "ok") return;
  if (result.status === "absent") {
    await setSetting("master_key_check", CANARY_PLAINTEXT, true);
    return;
  }

  throw new Error(
    "UNCLAW_MASTER_KEY does not match the key that encrypted the stored data — " +
    "provider keys cannot be decrypted. Restore the original key (the admin → security " +
    "page shows the value to copy) or clear the database to start fresh.",
  );
}

export async function isSetupComplete(): Promise<boolean> {
  const val = await getSetting("setup_complete");
  return val === "true";
}

/**
 * Strict SSRF policy for admin-supplied provider URLs. Off by default so
 * self-hosted LiteLLM/Ollama on private/loopback addresses work out of the box;
 * when on, those ranges are blocked too (link-local/metadata is always blocked).
 */
export async function getBlockPrivateProviderUrls(): Promise<boolean> {
  return (await getSetting("block_private_provider_urls")) === "true";
}

/**
 * How provider keys are sourced across the instance (admin-chosen):
 *  - shared_plus_own: admin's key is the shared default; users MAY add their own
 *  - shared_only:     everyone uses the admin's key; users cannot add their own
 *  - own_only:        no sharing; every user must bring their own key
 */
export type ProviderKeyMode = "shared_plus_own" | "shared_only" | "own_only";

/**
 * Resolve the active mode. Reads the new `provider_key_mode` setting and falls
 * back to the legacy `share_admin_providers` boolean for instances that predate
 * it (true → shared_plus_own, false → own_only). Default for a fresh instance is
 * shared_plus_own — the friendliest for non-technical teams on one admin key.
 */
export async function getProviderKeyMode(): Promise<ProviderKeyMode> {
  const mode = await getSetting("provider_key_mode");
  if (mode === "shared_plus_own" || mode === "shared_only" || mode === "own_only") return mode;
  // Legacy compatibility: derive from the old boolean if the new key is unset.
  const legacy = await getSetting("share_admin_providers");
  if (legacy === "false") return "own_only";
  return "shared_plus_own";
}

/** Whether the shared (admin) key may back users who have no key of their own. */
export async function sharedKeyEnabled(): Promise<boolean> {
  return (await getProviderKeyMode()) !== "own_only";
}

/** Whether users are allowed to add their own provider key. */
export async function ownKeysAllowed(): Promise<boolean> {
  return (await getProviderKeyMode()) !== "shared_only";
}
