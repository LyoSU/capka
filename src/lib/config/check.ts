import { isValidMasterKey } from "@/lib/crypto";

export type ConfigIssue = { level: "error" | "warn"; key: string; message: string };

/**
 * Boot-time configuration audit. Returns EVERY problem found in `env` so the
 * caller can log them as one loud block — far better than a misconfigured var
 * failing cryptically hours later, or silently falling back to a default the
 * operator never intended (the classic `Number(env.X) || default` footgun: a
 * typo'd `PG_POOL_MAX=10g` quietly becomes 10, and nobody notices).
 *
 * Pure and total: never throws, never reads the DB, never touches the network.
 * It only inspects the vars THIS (the Next.js server) process actually reads —
 * the sandbox controller validates its own secrets in its own process, so we
 * don't reach across that boundary. Severity is advisory; the server still
 * boots either way, because the setup/diagnostic page must always load.
 */
export function checkConfig(env: Record<string, string | undefined> = process.env): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  // Production profile: settings that are merely insecure-but-tolerable in dev are
  // real misconfigurations in production, so they're escalated from warn to error.
  const isProd = env.NODE_ENV === "production";

  const masterKey = env.CAPKA_MASTER_KEY?.trim();
  if (masterKey && !isValidMasterKey(masterKey)) {
    issues.push({
      level: "error",
      key: "CAPKA_MASTER_KEY",
      message:
        "set but malformed — must be 64 hex characters (32 bytes). Generate one with: " +
        "openssl rand -hex 32. Encryption/decryption of every stored key will fail until fixed.",
    });
  } else if (!masterKey) {
    // The whole point of CAPKA_MASTER_KEY is to keep the key OUT of the DB, so a
    // DB leak can't decrypt provider keys. Falling back to a DB-stored key defeats
    // that — tolerable for a quick local run, a real hole in production.
    issues.push({
      level: isProd ? "error" : "warn",
      key: "CAPKA_MASTER_KEY",
      message:
        "not set — a master key will be generated and stored in the DB. This is insecure " +
        "(a DB leak then exposes every provider key). Set it in production: openssl rand -hex 32.",
    });
  }

  const dbUrl = env.DATABASE_URL?.trim();
  if (!dbUrl) {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "DATABASE_URL",
      message: "not set — falling back to the local default (postgres on localhost:5432).",
    });
  } else if (!/^postgres(ql)?:\/\//.test(dbUrl)) {
    issues.push({
      level: "error",
      key: "DATABASE_URL",
      message: "must be a postgres:// (or postgresql://) connection string.",
    });
  }

  // PUBLIC_URL wins, BETTER_AUTH_URL is the legacy fallback; either, if present,
  // must parse as an http(s) origin or auth redirects break in confusing ways.
  for (const key of ["PUBLIC_URL", "BETTER_AUTH_URL"] as const) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    let ok = false;
    try {
      const p = new URL(raw).protocol;
      ok = p === "http:" || p === "https:";
    } catch {
      ok = false;
    }
    if (!ok) {
      issues.push({ level: "error", key, message: "set but is not a valid http(s) URL." });
    }
  }

  // Numeric knobs this process reads via `Number(env.X) || default`: a non-positive
  // or non-numeric value is silently swallowed, so surface the typo at boot.
  for (const key of [
    "PG_POOL_MAX",
    "WORKER_MAX_CONCURRENCY",
    "TASK_TIMEOUT_MINUTES",
    "STREAM_IDLE_SECONDS",
    "MAX_STREAM_RECOVERIES",
    "MAX_AGENT_STEPS",
    "FORCE_TEXT_AFTER_STEPS",
  ] as const) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      issues.push({
        level: "warn",
        key,
        message: `set to "${raw}", which is not a positive integer — the built-in default will be used instead.`,
      });
    }
  }

  // Retention days accept zero as an explicit "keep forever". The batch size
  // must stay positive or a cleanup run could spin without making progress.
  for (const key of ["TASK_RETENTION_DAYS", "USAGE_RETENTION_DAYS", "AUDIT_RETENTION_DAYS"] as const) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      issues.push({
        level: "warn",
        key,
        message: `set to "${raw}", which is not a non-negative integer — the built-in default will be used instead.`,
      });
    }
  }
  // Tracing. Advisory, like everything here — the actual enforcement of the
  // content policy lives in resolveTelemetryConfig, because this function never
  // blocks boot and so cannot be what prevents a data leak.
  const otlp = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)?.trim();
  let otlpHost: string | undefined;
  if (otlp) {
    try {
      const u = new URL(otlp);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
      otlpHost = u.hostname;
    } catch {
      issues.push({
        level: "error",
        key: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" : "OTEL_EXPORTER_OTLP_ENDPOINT",
        message: `set to "${otlp}", which is not a valid http(s) URL — traces will not be exported.`,
      });
    }
    const protocol = env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim();
    if (protocol && protocol !== "http/protobuf" && protocol !== "http/json") {
      issues.push({
        level: "warn",
        key: "OTEL_EXPORTER_OTLP_PROTOCOL",
        message: `set to "${protocol}", which is not supported (only http/protobuf and http/json) — http/protobuf will be used.`,
      });
    }
  }

  if (env.CAPKA_TELEMETRY_CONTENT?.trim() === "true") {
    const isLocal = otlpHost !== undefined && (
      otlpHost === "localhost" || otlpHost.endsWith(".localhost") || otlpHost.endsWith(".local") ||
      otlpHost === "::1" || /^127\./.test(otlpHost) || /^10\./.test(otlpHost) ||
      /^192\.168\./.test(otlpHost) || /^169\.254\./.test(otlpHost) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(otlpHost)
    );
    if (!otlp) {
      issues.push({
        level: "warn",
        key: "CAPKA_TELEMETRY_CONTENT",
        message: "set but no OTLP endpoint is configured — it has no effect.",
      });
    } else if (!isLocal && env.CAPKA_TELEMETRY_CONTENT_REMOTE?.trim() !== "true") {
      issues.push({
        level: "error",
        key: "CAPKA_TELEMETRY_CONTENT",
        message:
          `would send chat content (prompts, user documents, tool output) to ${otlpHost}, which is not this host. ` +
          "It is being IGNORED until CAPKA_TELEMETRY_CONTENT_REMOTE=true is also set.",
      });
    }
  }

  const retentionBatch = env.DB_RETENTION_BATCH_SIZE?.trim();
  if (retentionBatch) {
    const n = Number(retentionBatch);
    if (!Number.isInteger(n) || n < 1) {
      issues.push({
        level: "warn",
        key: "DB_RETENTION_BATCH_SIZE",
        message: `set to "${retentionBatch}", which is not a positive integer — the built-in default will be used instead.`,
      });
    }
  }

  return issues;
}

/** Run {@link checkConfig} and log each issue at its severity. Called once at
 *  boot (see instrumentation.register). Returns the issues for testability. */
export function reportConfig(env: Record<string, string | undefined> = process.env): ConfigIssue[] {
  const issues = checkConfig(env);
  for (const issue of issues) {
    const line = `[config] ${issue.key}: ${issue.message}`;
    if (issue.level === "error") console.error(line);
    else console.warn(line);
  }
  return issues;
}
