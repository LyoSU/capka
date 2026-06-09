import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

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

/** A master key must be 32 bytes encoded as 64 hex chars (AES-256). */
export function isValidMasterKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}
