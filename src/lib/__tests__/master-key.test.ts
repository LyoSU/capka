import { describe, it, expect } from "vitest";
import { encrypt, generateSecret } from "../crypto";
import { checkMasterKey, CANARY_PLAINTEXT } from "../master-key";

describe("checkMasterKey", () => {
  const key = generateSecret();

  it("reports 'absent' when no canary has been stored yet (first boot)", () => {
    expect(checkMasterKey(null, key)).toEqual({ status: "absent" });
  });

  it("reports 'ok' when the canary decrypts to the expected constant", () => {
    const canary = encrypt(CANARY_PLAINTEXT, key);
    expect(checkMasterKey(canary, key)).toEqual({ status: "ok" });
  });

  it("reports 'mismatch' when the canary was encrypted with a different key", () => {
    const canary = encrypt(CANARY_PLAINTEXT, generateSecret());
    expect(checkMasterKey(canary, key)).toEqual({ status: "mismatch" });
  });

  it("reports 'mismatch' when the canary decrypts but to an unexpected value", () => {
    const canary = encrypt("not-the-canary", key);
    expect(checkMasterKey(canary, key)).toEqual({ status: "mismatch" });
  });
});
