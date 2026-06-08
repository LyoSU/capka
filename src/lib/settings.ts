import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./db/schema";
import { encrypt, decrypt, generateSecret } from "./crypto";

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

export async function isSetupComplete(): Promise<boolean> {
  const val = await getSetting("setup_complete");
  return val === "true";
}
