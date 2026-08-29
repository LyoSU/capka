import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blobPath, putBlob, readBlob } from "@/lib/vault/cas";

/**
 * Pure unit test: no database. `root()` in cas.ts reads process.env on every
 * call (not at import time), so pointing VAULT_CAS_DIR at a throwaway temp
 * directory in beforeAll is enough — the module never touches the repo's
 * real `data/` directory, where actual sandbox workspaces live.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vault-cas-test-"));
  process.env.VAULT_CAS_DIR = dir;
});

afterAll(async () => {
  delete process.env.VAULT_CAS_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("vault CAS", () => {
  it("put/read round-trip з кирилицею", async () => {
    const bytes = Buffer.from("Привіт, світ! Це вміст файлу.", "utf8");
    const sha = await putBlob(bytes);
    expect(sha).toBe(createHash("sha256").update(bytes).digest("hex"));
    const read = await readBlob(sha);
    expect(read.equals(bytes)).toBe(true);
  });

  it("повторний put повертає той самий ключ", async () => {
    const bytes = Buffer.from("idempotent content");
    const sha1 = await putBlob(bytes);
    const sha2 = await putBlob(bytes);
    expect(sha1).toBe(sha2);
    const read = await readBlob(sha1);
    expect(read.equals(bytes)).toBe(true);
  });

  it("8 конкурентних put одних байтів → один ключ, без помилок", async () => {
    const bytes = Buffer.from("concurrent-write-race-content");
    const results = await Promise.all(Array.from({ length: 8 }, () => putBlob(bytes)));
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(results).toEqual(Array(8).fill(expected));

    // No leftover .<uuid>.tmp file in the shard directory once every
    // concurrent writer has settled — cleanup is part of the contract.
    const shardDir = path.dirname(blobPath(expected));
    const entries = await readdir(shardDir);
    expect(entries).toEqual([expected]);
  });

  it("шлях шардований ab/cd/<sha>", () => {
    const bytes = Buffer.from("shard-path-check");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const expected = path.join(dir, sha.slice(0, 2), sha.slice(2, 4), sha);
    expect(blobPath(sha)).toBe(expected);
  });

  it("blobPath з невалідним ключем кидає синхронно", () => {
    expect(() => blobPath("../etc/passwd")).toThrow();
    expect(() => blobPath("ABC")).toThrow();
  });

  it("readBlob для добре сформованого, але відсутнього ключа — reject", async () => {
    await expect(readBlob("0".repeat(64))).rejects.toThrow();
  });
});
