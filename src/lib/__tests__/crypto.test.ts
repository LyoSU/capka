import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateSecret } from "../crypto";

describe("crypto", () => {
  it("encrypts and decrypts correctly", () => {
    const key = generateSecret();
    const plaintext = "sk-proj-abc123456";
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(":")).toHaveLength(3);
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const key1 = generateSecret();
    const key2 = generateSecret();
    const encrypted = encrypt("secret", key1);
    expect(() => decrypt(encrypted, key2)).toThrow();
  });
});
