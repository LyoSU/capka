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
  for (const key of ["PG_POOL_MAX", "WORKER_MAX_CONCURRENCY"] as const) {
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
