import { isValidMasterKey } from "@/lib/crypto";

export type ConfigIssue = { level: "error" | "warn"; key: string; message: string };

/**
 * The five expression shapes the read sites actually use, as executable MIRRORS:
 * `used` returns what that site will end up using for a given raw value, and `ok`
 * is the site's own validity domain.
 *
 * Mirrors rather than prose, because a comment cannot be tested and this file was
 * wrong for two releases while reading as if it were right. checkConfig used to
 * apply ONE rule — positive integer, "the built-in default will be used instead" —
 * to every knob below, and it was wrong in both directions:
 *
 *   - It UNDER-reported. Bare `Number(env.X) || default` lets a negative through
 *     (it is truthy), so TASK_TIMEOUT_MINUTES=-1 was announced as ignored and then
 *     used, which aborts every turn at ~1ms and leaves the wrap-up brake reading a
 *     descending fraction it can never cross.
 *   - It OVER-reported. MCP_DEFER_TOKEN_PCT=0 is a documented, test-guaranteed
 *     policy ("always defer") that its read site honours, yet boot told the operator
 *     the value had been discarded.
 *
 * So a message must name the value that will ACTUALLY run. A diagnostic naming a
 * mechanism that does not exist is worse than no diagnostic: the operator believes
 * the default is running and goes looking for the fault somewhere else.
 */
const isPosInt = (n: number) => Number.isInteger(n) && n > 0;
const isNonNegInt = (n: number) => Number.isInteger(n) && n >= 0;
const isFiniteNonNeg = (n: number) => Number.isFinite(n) && n >= 0;

export const KNOB_SHAPES = {
  /** `posInt(...)` in tool-output.ts, `positiveInt(...)` in db/retention.ts. */
  posInt: { used: (raw: string, d: number) => (isPosInt(Number(raw)) ? Number(raw) : d), ok: isPosInt, domain: "a positive integer" },
  /** `nonNegativeInt(...)` in db/retention.ts — 0 days means keep forever. */
  nonNegInt: { used: (raw: string, d: number) => (isNonNegInt(Number(raw)) ? Number(raw) : d), ok: isNonNegInt, domain: "a non-negative integer" },
  /** `envNumber(...)` in mcp/tool-search.ts — 0 and fractions are DELIBERATE. */
  finiteNonNeg: { used: (raw: string, d: number) => (isFiniteNonNeg(Number(raw)) ? Number(raw) : d), ok: isFiniteNonNeg, domain: "a non-negative number" },
  /** Bare `Number(env.X) || default`: NO guard. Every negative, every fraction and
   *  Infinity is truthy, so it survives and runs as written. */
  truthy: { used: (raw: string, d: number) => Number(raw) || d, ok: isPosInt, domain: "a positive integer" },
  /** `Math.max(1, parseInt(env.X || "3", 10) || 3)` in worker.ts: prefix-parsed, so
   *  `10g` becomes 10 and RUNS, `2.7` truncates to 2, a negative clamps to 1 — three
   *  outcomes, none of them the built-in default. */
  parseIntClamped: { used: (raw: string, d: number) => Math.max(1, parseInt(raw, 10) || d), ok: isPosInt, domain: "a positive integer" },
} as const;

/**
 * Every numeric knob this process reads, with the shape of its read site and the
 * file that read site lives in. `site` is not decoration: config-check.test.ts
 * asserts each file still reads its knob in the shape claimed here, so moving a
 * knob onto a different helper fails loudly instead of silently de-synchronising
 * this table from the code it describes.
 */
export const NUMERIC_KNOBS: {
  key: string;
  fallback: number;
  shape: keyof typeof KNOB_SHAPES;
  site: string;
}[] = [
  { key: "MAX_TOOL_OUTPUT_CHARS", fallback: 30_000, shape: "posInt", site: "src/lib/tool-output.ts" },
  { key: "MAX_TOOL_OUTPUT_LINES", fallback: 1500, shape: "posInt", site: "src/lib/tool-output.ts" },
  { key: "MAX_TURN_TOOL_OUTPUT_CHARS", fallback: 400_000, shape: "posInt", site: "src/lib/tool-output.ts" },
  { key: "DB_RETENTION_BATCH_SIZE", fallback: 1000, shape: "posInt", site: "src/lib/db/retention.ts" },
  { key: "TASK_RETENTION_DAYS", fallback: 30, shape: "nonNegInt", site: "src/lib/db/retention.ts" },
  { key: "USAGE_RETENTION_DAYS", fallback: 365, shape: "nonNegInt", site: "src/lib/db/retention.ts" },
  { key: "AUDIT_RETENTION_DAYS", fallback: 365, shape: "nonNegInt", site: "src/lib/db/retention.ts" },
  { key: "MCP_DEFER_TOKEN_PCT", fallback: 10, shape: "finiteNonNeg", site: "src/lib/mcp/tool-search.ts" },
  { key: "MCP_DEFER_TOKEN_MAX", fallback: 8192, shape: "finiteNonNeg", site: "src/lib/mcp/tool-search.ts" },
  { key: "PG_POOL_MAX", fallback: 20, shape: "truthy", site: "src/lib/db/index.ts" },
  { key: "TASK_TIMEOUT_MINUTES", fallback: 20, shape: "truthy", site: "src/lib/tasks/runner.ts" },
  { key: "STREAM_IDLE_SECONDS", fallback: 60, shape: "truthy", site: "src/lib/tasks/runner.ts" },
  { key: "MAX_STREAM_RECOVERIES", fallback: 3, shape: "truthy", site: "src/lib/tasks/runner.ts" },
  { key: "MAX_AGENT_STEPS", fallback: 25, shape: "truthy", site: "src/lib/chat/context/step-control.ts" },
  { key: "JOBS_KEEP_DIRS", fallback: 20, shape: "truthy", site: "src/lib/sandbox/tools.ts" },
  { key: "JOB_LOG_CAP_MB", fallback: 10, shape: "truthy", site: "src/lib/sandbox/tools.ts" },
  { key: "OUTPUT_KEEP_FILES", fallback: 5, shape: "truthy", site: "src/lib/sandbox/tools.ts" },
  { key: "OUTPUT_FILE_CAP_MB", fallback: 10, shape: "truthy", site: "src/lib/sandbox/tools.ts" },
  { key: "VIEW_KEEP_DIRS", fallback: 4, shape: "truthy", site: "src/lib/sandbox/view-file.ts" },
  { key: "MAX_MCP_MEDIA_BYTES", fallback: 5 * 1024 * 1024, shape: "truthy", site: "src/lib/mcp/adapt.ts" },
  { key: "MAX_MCP_TOOL_DESC_CHARS", fallback: 1024, shape: "truthy", site: "src/lib/mcp/adapt.ts" },
  { key: "WORKER_MAX_CONCURRENCY", fallback: 3, shape: "parseIntClamped", site: "src/lib/tasks/worker.ts" },
];

/**
 * Boot-time configuration audit. Returns EVERY problem found in `env` so the
 * caller can log them as one loud block — far better than a misconfigured var
 * failing cryptically hours later, or silently falling back to a default the
 * operator never intended. There is no single footgun to name, and that is the
 * point: `PG_POOL_MAX=10g` reads through `Number()` and becomes the default 20,
 * while the same typo in `WORKER_MAX_CONCURRENCY` reads through `parseInt()` and
 * quietly becomes 10 — one silently ignored, one silently obeyed. So every knob is
 * checked against the rule its OWN read site implements; see the `knobs` table.
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

  for (const { key, fallback, shape } of NUMERIC_KNOBS) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") continue;
    const { used, ok, domain } = KNOB_SHAPES[shape];
    const n = Number(raw);
    const effective = used(raw, fallback);
    if (ok(n) && effective === n) continue;
    issues.push(
      effective === n
        ? {
            // The read site has no guard, so this value survives and runs. This is the
            // half the old single message actively denied.
            level: "error",
            key,
            message: `set to "${raw}", which is not ${domain} — it will be used AS WRITTEN, not replaced by the default. Set a valid value or unset it.`,
          }
        : {
            level: "warn",
            key,
            message: `set to "${raw}", which is not ${domain} — ${effective} will be used instead.`,
          },
    );
  }

  // Derived default and a two-sided clamp: `Math.min(MAX_STEPS, Math.max(1, ... ||
  // MAX_STEPS - 5))`. Neither its valid range nor its effective value can be stated
  // without reading MAX_AGENT_STEPS first, which is also why raising that knob alone
  // moves this one.
  {
    const raw = env.FORCE_TEXT_AFTER_STEPS?.trim();
    if (raw !== undefined && raw !== "") {
      const maxSteps = Number(env.MAX_AGENT_STEPS) || 25;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > maxSteps) {
        const effective = Math.min(maxSteps, Math.max(1, n || maxSteps - 5));
        issues.push({
          level: "warn",
          key: "FORCE_TEXT_AFTER_STEPS",
          message: `set to "${raw}", which is not an integer in 1–${maxSteps} (the MAX_AGENT_STEPS ceiling) — ${effective} will be used instead.`,
        });
      }
    }
  }

  // Validated against the CLAMP in step-control.ts rather than the open interval:
  // a value inside (0,1) but outside the clamp is silently rewritten too, so what
  // the operator wrote is not what runs, and that is the whole thing worth saying at
  // boot. It is NOT the only non-integer knob — MCP_DEFER_TOKEN_PCT takes fractions
  // as well; this one keeps its own block because it is caught between two bounds.
  // What was unique is why it got noticed at all: its default (0.8) violated the
  // integer sweep, so the sweep rejected its OWN default and forced someone to look.
  // A rule that only breaks on non-default values has no self-check, and every knob
  // whose default happened to satisfy that sweep stayed mis-reported for releases.
  {
    const raw = env.WRAP_UP_AFTER_FRACTION?.trim();
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0.1 || n > 0.95) {
        issues.push({
          level: "warn",
          key: "WRAP_UP_AFTER_FRACTION",
          message: `set to "${raw}", which is outside the usable 0.1–0.95 range — it will be clamped.`,
        });
      }
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
