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

  it("validates retention knobs while allowing zero days to mean keep forever", () => {
    expect(keysOf({ ...VALID, TASK_RETENTION_DAYS: "0", USAGE_RETENTION_DAYS: "730", AUDIT_RETENTION_DAYS: "90", DB_RETENTION_BATCH_SIZE: "250" }))
      .not.toEqual(expect.arrayContaining(["TASK_RETENTION_DAYS", "USAGE_RETENTION_DAYS", "AUDIT_RETENTION_DAYS", "DB_RETENTION_BATCH_SIZE"]));
    expect(checkConfig({ ...VALID, TASK_RETENTION_DAYS: "-1" })).toContainEqual(
      expect.objectContaining({ key: "TASK_RETENTION_DAYS", level: "warn" }),
    );
    expect(checkConfig({ ...VALID, DB_RETENTION_BATCH_SIZE: "0" })).toContainEqual(
      expect.objectContaining({ key: "DB_RETENTION_BATCH_SIZE", level: "warn" }),
    );
  });

  // The one knob here that is deliberately fractional. The integer sweep above
  // would reject its own default, so it needs a check of its own — and without one
  // a typo is clamped in silence, which for this knob means the wrap-up brake
  // quietly arms at a moment the operator never asked for.
  it("accepts a fractional WRAP_UP_AFTER_FRACTION and warns outside the usable range", () => {
    expect(keysOf({ ...VALID, WRAP_UP_AFTER_FRACTION: "0.8" })).toEqual([]);
    expect(keysOf({ ...VALID, WRAP_UP_AFTER_FRACTION: "0.5" })).toEqual([]);

    // 0.05 and 0.99 are numbers, but the reader clamps them — so as written they
    // are not what will run, which is the silence this warning exists to break.
    for (const bad of ["1", "0", "-0.2", "1.5", "0.05", "0.99", "eighty percent"]) {
      expect(keysOf({ ...VALID, WRAP_UP_AFTER_FRACTION: bad })).toContain("WRAP_UP_AFTER_FRACTION");
    }
  });

  it("does not sweep the fractional knob into the positive-integer check", () => {
    // Listing it alongside TASK_TIMEOUT_MINUTES would warn on every valid value.
    const issues = checkConfig({ ...VALID, WRAP_UP_AFTER_FRACTION: "0.8" });
    expect(issues.map((i) => i.message).join(" ")).not.toContain("positive integer");
  });
});

describe("checkConfig — telemetry", () => {
  it("says nothing when telemetry is not configured", () => {
    expect(keysOf(VALID)).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  it("errors on a malformed OTLP endpoint", () => {
    const issues = checkConfig({ ...VALID, OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" });
    expect(issues.find((i) => i.key === "OTEL_EXPORTER_OTLP_ENDPOINT")?.level).toBe("error");
  });

  it("errors when chat content would be sent to a third-party host", () => {
    const issues = checkConfig({
      ...VALID,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://cloud.langfuse.com/api/public/otel",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    const issue = issues.find((i) => i.key === "CAPKA_TELEMETRY_CONTENT");
    expect(issue?.level).toBe("error");
    expect(issue?.message).toContain("cloud.langfuse.com");
  });

  it("accepts content capture toward a local collector", () => {
    const issues = checkConfig({
      ...VALID,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      CAPKA_TELEMETRY_CONTENT: "true",
    });
    expect(keysOf({ ...VALID })).not.toContain("CAPKA_TELEMETRY_CONTENT");
    expect(issues.find((i) => i.key === "CAPKA_TELEMETRY_CONTENT")).toBeUndefined();
  });

  it("warns when a content flag has no endpoint to apply to", () => {
    const issues = checkConfig({ ...VALID, CAPKA_TELEMETRY_CONTENT: "true" });
    expect(issues.find((i) => i.key === "CAPKA_TELEMETRY_CONTENT")?.level).toBe("warn");
  });

  it("warns about an OTLP protocol it cannot produce", () => {
    const issues = checkConfig({
      ...VALID,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    });
    expect(issues.find((i) => i.key === "OTEL_EXPORTER_OTLP_PROTOCOL")?.level).toBe("warn");
  });
});
