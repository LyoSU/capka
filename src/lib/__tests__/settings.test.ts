import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encrypt } from "../crypto";
import { CANARY_PLAINTEXT } from "../master-key";

// Mock the DB so getMasterKey's fallback path never touches a real database.
const dbRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => dbRows.rows }) }) }),
    insert: () => ({ values: async () => undefined }),
  },
}));

describe("getMasterKey", () => {
  const ORIGINAL = process.env.CAPKA_MASTER_KEY;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    dbRows.rows = [];
    if (ORIGINAL === undefined) delete process.env.CAPKA_MASTER_KEY;
    else process.env.CAPKA_MASTER_KEY = ORIGINAL;
  });

  it("returns CAPKA_MASTER_KEY from env when set, ignoring the DB", async () => {
    process.env.CAPKA_MASTER_KEY = "deadbeef".repeat(8); // 64 hex chars
    const { getMasterKey } = await import("../settings");
    expect(await getMasterKey()).toBe("deadbeef".repeat(8));
  });

  it("trims surrounding whitespace from the env value", async () => {
    // A valid key, because `getMasterKey` now validates the shape at the root of trust — a
    // short or non-hex value used to fail later, deep inside a cipher, or silently become a
    // weaker HMAC key (which accepts any length and would report nothing).
    const key = "a".repeat(64);
    process.env.CAPKA_MASTER_KEY = `  ${key}  `;
    const { getMasterKey } = await import("../settings");
    expect(await getMasterKey()).toBe(key);
  });

  it("refuses a master key that is not 32 bytes of hex", async () => {
    process.env.CAPKA_MASTER_KEY = "abc123";
    const { getMasterKey } = await import("../settings");
    await expect(getMasterKey()).rejects.toThrow(/64 hex characters/);
  });

  it("on a key mismatch, points at both places the original key can live", async () => {
    // The original may have been an env key (.env backup) or a DB-stored one that an
    // operator replaced with a new env value (the auth_secret row) — name both.
    process.env.CAPKA_MASTER_KEY = "a".repeat(64);
    dbRows.rows = [{ value: encrypt(CANARY_PLAINTEXT, "b".repeat(64)) }];
    const { assertMasterKeyConsistent } = await import("../settings");
    const err = await assertMasterKeyConsistent().then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/\.env backup/);
    expect(err?.message).toMatch(/auth_secret/);
  });
});
