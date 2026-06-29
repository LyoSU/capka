import { decrypt } from "./crypto";

/**
 * Key Check Value (KCV) for the master key. A known constant is stored
 * encrypted with the active master key the first time the key is established.
 * On boot we decrypt it: if that fails (or yields the wrong value) we know the
 * active key no longer matches the key that encrypted the data at rest — so we
 * can fail fast with a clear message instead of letting provider-key decryption
 * blow up with a cryptic GCM error at request time.
 *
 * Bump the suffix only if the canary format ever changes.
 */
export const CANARY_PLAINTEXT = "capka-master-key-check-v1";

export type MasterKeyCheck =
  /** No canary persisted yet — first boot (or pre-KCV install). Caller writes one. */
  | { status: "absent" }
  /** Canary decrypts to the expected constant — the key matches the data. */
  | { status: "ok" }
  /** Canary won't decrypt with this key, or decrypts to something else — wrong key. */
  | { status: "mismatch" };

export function checkMasterKey(canaryCiphertext: string | null, key: string): MasterKeyCheck {
  if (!canaryCiphertext) return { status: "absent" };
  try {
    return decrypt(canaryCiphertext, key) === CANARY_PLAINTEXT
      ? { status: "ok" }
      : { status: "mismatch" };
  } catch {
    return { status: "mismatch" };
  }
}
