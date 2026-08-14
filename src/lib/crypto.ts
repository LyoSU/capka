import { randomBytes, createCipheriv, createDecipheriv, createHmac } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string, keyHex: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext (expected iv:tag:data)");
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("Master key must be 32 bytes (64 hex characters)");
  }
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A stable, non-reversible marker for a value that must be comparable but must not be
 * stored — a plugin's command line in the install surface
 * (docs/plugin-install-review-spec.md §4).
 *
 * Keyed, not a plain digest: a command line or an env value is often low-entropy
 * enough to recover from a wordlist, and a digest that can be confirmed by guessing
 * would leak the contents of a private plugin. The key is DERIVED from the master key
 * under a fixed label rather than used directly, so these digests are not comparable
 * with any other HMAC the instance computes under the same master key
 * (`sandbox/client.ts` does).
 */
export function fingerprint(canonicalValue: string, keyHex: string): string {
  const derived = createHmac("sha256", Buffer.from(keyHex, "hex")).update("capka:plugin-surface:v1").digest();
  return createHmac("sha256", derived).update(canonicalValue).digest("hex");
}

/** A master key must be 32 bytes encoded as 64 hex chars (AES-256). */
export function isValidMasterKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}
