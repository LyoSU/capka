import { describe, it, expect } from "vitest";
import { checkConfig } from "../config/check";

// A fully-valid environment as the baseline; each case overrides one var so the
// assertions stay about that var alone.
const VALID: Record<string, string | undefined> = {
  CAPKA_MASTER_KEY: "a".repeat(64),
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  PUBLIC_URL: "https://app.example.com",
};

const keysOf = (env: Record<string, string | undefined>) => checkConfig(env).map((i) => i.key);

describe("checkConfig", () => {
  it("reports nothing for a fully-valid environment", () => {
    expect(checkConfig(VALID)).toEqual([]);
  });

  it("errors on a malformed master key but warns when it is absent", () => {
    const bad = checkConfig({ ...VALID, CAPKA_MASTER_KEY: "nope" });
    expect(bad).toContainEqual(expect.objectContaining({ key: "CAPKA_MASTER_KEY", level: "error" }));

    const absent = checkConfig({ ...VALID, CAPKA_MASTER_KEY: undefined });
    expect(absent).toContainEqual(expect.objectContaining({ key: "CAPKA_MASTER_KEY", level: "warn" }));
  });

  it("warns when DATABASE_URL is absent and errors on a non-postgres scheme", () => {
    expect(checkConfig({ ...VALID, DATABASE_URL: undefined })).toContainEqual(
      expect.objectContaining({ key: "DATABASE_URL", level: "warn" }),
    );
    expect(checkConfig({ ...VALID, DATABASE_URL: "mysql://x" })).toContainEqual(
      expect.objectContaining({ key: "DATABASE_URL", level: "error" }),
    );
  });

  it("accepts both postgres:// and postgresql:// schemes", () => {
    expect(keysOf({ ...VALID, DATABASE_URL: "postgres://u:p@db:5432/app" })).not.toContain("DATABASE_URL");
  });

  it("errors on a malformed PUBLIC_URL / BETTER_AUTH_URL but ignores an absent one", () => {
    expect(checkConfig({ ...VALID, PUBLIC_URL: "not a url" })).toContainEqual(
      expect.objectContaining({ key: "PUBLIC_URL", level: "error" }),
    );
    expect(checkConfig({ ...VALID, BETTER_AUTH_URL: "ftp://x" })).toContainEqual(
      expect.objectContaining({ key: "BETTER_AUTH_URL", level: "error" }),
    );
    // PUBLIC_URL set & valid, BETTER_AUTH_URL simply absent → no issue.
    expect(keysOf(VALID)).not.toContain("BETTER_AUTH_URL");
  });

  it("escalates insecure-but-tolerable defaults to errors in production", () => {
    const dev = checkConfig({ ...VALID, CAPKA_MASTER_KEY: undefined, DATABASE_URL: undefined });
    expect(dev.find((i) => i.key === "CAPKA_MASTER_KEY")?.level).toBe("warn");
    expect(dev.find((i) => i.key === "DATABASE_URL")?.level).toBe("warn");

    const prod = checkConfig({ ...VALID, NODE_ENV: "production", CAPKA_MASTER_KEY: undefined, DATABASE_URL: undefined });
    expect(prod.find((i) => i.key === "CAPKA_MASTER_KEY")?.level).toBe("error");
    expect(prod.find((i) => i.key === "DATABASE_URL")?.level).toBe("error");
  });

  it("warns on a non-positive-integer numeric knob and accepts a valid one", () => {
    expect(checkConfig({ ...VALID, PG_POOL_MAX: "10g" })).toContainEqual(
      expect.objectContaining({ key: "PG_POOL_MAX", level: "warn" }),
    );
    expect(checkConfig({ ...VALID, WORKER_MAX_CONCURRENCY: "0" })).toContainEqual(
      expect.objectContaining({ key: "WORKER_MAX_CONCURRENCY", level: "warn" }),
    );
    expect(keysOf({ ...VALID, PG_POOL_MAX: "20", WORKER_MAX_CONCURRENCY: "4" })).not.toContain("PG_POOL_MAX");
  });
});
