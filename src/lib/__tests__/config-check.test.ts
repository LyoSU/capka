import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkConfig, KNOB_SHAPES, NUMERIC_KNOBS } from "../config/check";
import { nonNegInt, posInt } from "@/lib/config/env";
import { readRetentionConfig } from "@/lib/db/retention";

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

// The half that was missing, and the reason this file could stay green while the
// diagnostic lied for two releases: nothing asserted that checkConfig's rule was
// the SAME rule the read site implements. A default-only test cannot cover it —
// every knob's default satisfies both rules, so the divergence exists only at
// non-default values, and a rule that breaks only there has no self-check.
describe("checkConfig — the diagnostic matches the mechanism", () => {
  it("stays silent on a value its read site genuinely honours", () => {
    // 0 and a fractional percent are documented, test-guaranteed policies in
    // mcp/tool-search.ts (`0` = always defer / no ceiling; see tool-search.test.ts).
    // Boot used to announce both as discarded while the reader honoured them.
    for (const raw of ["0", "10.5", "0.5"]) {
      expect(keysOf({ ...VALID, MCP_DEFER_TOKEN_PCT: raw })).not.toContain("MCP_DEFER_TOKEN_PCT");
      expect(keysOf({ ...VALID, MCP_DEFER_TOKEN_MAX: raw })).not.toContain("MCP_DEFER_TOKEN_MAX");
    }
  });

  it("no longer has a knob whose value runs unvalidated", () => {
    // TASK_TIMEOUT_MINUTES=-1 was the case that proved the class: truthy, so it passed
    // `Number(env.X) || default` and ran, aborting every turn at ~1ms. Its read site is
    // now posInt, so the value falls back and the message says which number runs.
    const issue = checkConfig({ ...VALID, TASK_TIMEOUT_MINUTES: "-1" }).find((i) => i.key === "TASK_TIMEOUT_MINUTES");
    expect(issue?.level).toBe("warn");
    expect(issue?.message).toContain("20 will be used");
    expect(issue?.message).not.toContain("AS WRITTEN");
    // And the reader agrees, rather than the message merely claiming so.
    expect(posInt(" -1 ", 20)).toBe(20);
    expect(posInt("45", 20)).toBe(45);

    // WORKER_MAX_CONCURRENCY was the last exception and is no longer one. Its site
    // prefix-parsed, so `10g` used to RUN at ten concurrent tasks; the title of this
    // test carried "except the one that does" until that site moved onto posInt.
    const worker = checkConfig({ ...VALID, WORKER_MAX_CONCURRENCY: "10g" }).find((i) => i.key === "WORKER_MAX_CONCURRENCY");
    expect(worker?.message).toContain("3 will be used");
    expect(worker?.message).not.toContain("AS WRITTEN");
    expect(posInt("10g", 3)).toBe(3);
  });

  it("honours a zero where zero is a policy, and rejects it where it is not", () => {
    // The trap in doing this conversion with ONE helper: a positive-only floor would
    // silently rewrite five knobs where zero means something, which is the same defect
    // one layer down. Zero is a policy when it selects a different working behaviour.
    for (const key of ["MAX_STREAM_RECOVERIES", "JOBS_KEEP_DIRS", "OUTPUT_KEEP_FILES", "VIEW_KEEP_DIRS", "MAX_MCP_MEDIA_BYTES"]) {
      expect(keysOf({ ...VALID, [key]: "0" })).not.toContain(key);
    }
    // ...and a mistake when it removes the output entirely: JOB_LOG_CAP_MB=0 is
    // `head -c 0`, an empty log rather than a smaller one.
    for (const key of ["JOB_LOG_CAP_MB", "OUTPUT_FILE_CAP_MB", "TASK_TIMEOUT_MINUTES", "PG_POOL_MAX", "MAX_AGENT_STEPS"]) {
      expect(keysOf({ ...VALID, [key]: "0" })).toContain(key);
    }
    // The readers themselves, so this is a property of the code and not of the table.
    expect(nonNegInt("0", 3)).toBe(0);
    expect(posInt("0", 10)).toBe(10);
    expect(nonNegInt("-1", 3)).toBe(3);
    expect(nonNegInt("", 3)).toBe(3);
    expect(nonNegInt("1.5", 3)).toBe(3);
  });

  it("keeps MAX_STREAM_RECOVERIES=0 silent as well as effective", () => {
    // `nonNegInt` returning 0 is necessary and NOT sufficient. Three facts hide behind
    // this one knob: the reader honours 0 (asserted just above), the stall loop then
    // performs no recovery, and no `task:notice` with kind "retrying" is published.
    // The third is the one an operator sees — the chat's status row renders it — so
    // without it someone who switched recovery off would still watch a "retrying…"
    // notice for a policy they disabled. A validator that returns 0 while the UI
    // narrates retries is a guard sitting next to the thing it was believed to
    // protect.
    //
    // Asserted on runner.ts's SOURCE, and the reason is not convenience: the
    // behavioural version needs the runner itself, whose suites are
    // RUN_INTEGRATION-gated and would not run in this job at all. Same route
    // chat/context/__tests__/step-control.test.ts already takes on this same file.
    // Comments are stripped first, because prose citing `kind: "retrying"` is
    // documentation, not a publish.
    //
    // NAMED WEAKNESS, so nobody reads this as more than it is: it pins the ORDER, not
    // the outcome. The exhaustion break precedes the publish, so at 0 the loop leaves
    // before a notice can exist — but a refactor that preserves the order while
    // changing the loop's shape could still break the consequence. The behavioural
    // assertion belongs in the gated runner suite when someone gets there.
    const runner = readFileSync(new URL("../tasks/runner.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const exhausted = runner.indexOf("recoveries >= MAX_RECOVERIES");
    const retryNotice = runner.indexOf('kind: "retrying"');
    expect(exhausted).toBeGreaterThan(-1);
    expect(retryNotice).toBeGreaterThan(-1);
    expect(exhausted).toBeLessThan(retryNotice);
  });

  it("names each knob's own default, now that one typo has one answer", () => {
    // This test used to document a divergence: `10g` ran at 10 through parseInt in
    // worker.ts and fell back to 20 through Number() in db/index.ts — same typo, two
    // mechanisms, which is why no single sentence about the class could be accurate.
    // The divergence is gone; what is still worth pinning is that the message names
    // the number THIS knob falls back to rather than a generic sentence about
    // defaults, since a message that cannot be wrong about a specific value is a
    // message an operator can act on.
    const worker = checkConfig({ ...VALID, WORKER_MAX_CONCURRENCY: "10g" }).find((i) => i.key === "WORKER_MAX_CONCURRENCY");
    expect(worker?.level).toBe("warn");
    expect(worker?.message).toContain("3 will be used");
    const pool = checkConfig({ ...VALID, PG_POOL_MAX: "10g" }).find((i) => i.key === "PG_POOL_MAX");
    expect(pool?.message).toContain("20 will be used");
    // And the clamp that used to swallow a negative is gone with it: `-4` no longer
    // runs single-threaded, it falls back and says so.
    const negative = checkConfig({ ...VALID, WORKER_MAX_CONCURRENCY: "-4" }).find((i) => i.key === "WORKER_MAX_CONCURRENCY");
    expect(negative?.message).toContain("3 will be used");
    expect(posInt("-4", 3)).toBe(3);
  });

  it("reads FORCE_TEXT_AFTER_STEPS against the ceiling MAX_AGENT_STEPS sets", () => {
    // Its default is derived (`MAX_STEPS - 5`) and it is clamped to [1, MAX_STEPS], so
    // its valid range moves when the other knob does. 30 is out of range by default
    // and fine once the ceiling is raised.
    expect(keysOf({ ...VALID, FORCE_TEXT_AFTER_STEPS: "30" })).toContain("FORCE_TEXT_AFTER_STEPS");
    expect(keysOf({ ...VALID, FORCE_TEXT_AFTER_STEPS: "30", MAX_AGENT_STEPS: "200" })).not.toContain("FORCE_TEXT_AFTER_STEPS");
    expect(checkConfig({ ...VALID, FORCE_TEXT_AFTER_STEPS: "30" })[0]?.message).toContain("1–25");
  });

  it("agrees with db/retention.ts on every value, not just its defaults", () => {
    // A true differential: readRetentionConfig takes env, so the real reader and the
    // mirror can be run side by side. If they disagree the message is fiction.
    const probes = ["0", "-1", "1.5", "abc", "", "90", "Infinity"];
    for (const raw of probes) {
      for (const [key, field, fallback] of [
        ["TASK_RETENTION_DAYS", "taskDays", 30],
        ["USAGE_RETENTION_DAYS", "usageDays", 365],
        ["AUDIT_RETENTION_DAYS", "auditDays", 365],
        ["DB_RETENTION_BATCH_SIZE", "batchSize", 1000],
      ] as const) {
        const real = readRetentionConfig({ [key]: raw })[field];
        const knob = NUMERIC_KNOBS.find((k) => k.key === key)!;
        const mirrored = raw === "" ? fallback : KNOB_SHAPES[knob.shape].used(raw, knob.fallback);
        expect({ key, raw, mirrored }).toEqual({ key, raw, mirrored: real });
        // And the diagnostic must be silent exactly when the value survives intact.
        const quiet = !keysOf({ ...VALID, [key]: raw }).includes(key);
        expect({ key, raw, quiet }).toEqual({ key, raw, quiet: raw === "" || real === Number(raw) });
      }
    }
  });

  it("agrees with tool-output.ts on every value", async () => {
    // Same differential for the module whose three knobs were fixed at their read
    // site; here the constants are baked at import, so the env has to be stubbed and
    // the module re-imported per probe.
    for (const [key, exported] of [
      ["MAX_TOOL_OUTPUT_CHARS", "MAX_TOOL_OUTPUT_CHARS"],
      ["MAX_TOOL_OUTPUT_LINES", "DEFAULT_READ_LINES"],
      ["MAX_TURN_TOOL_OUTPUT_CHARS", "MAX_TURN_TOOL_OUTPUT_CHARS"],
    ] as const) {
      for (const raw of ["-1", "0", "1.5", "abc", "700"]) {
        vi.resetModules();
        vi.stubEnv(key, raw);
        const mod = (await import("@/lib/tool-output")) as unknown as Record<string, number>;
        const knob = NUMERIC_KNOBS.find((k) => k.key === key)!;
        expect({ key, raw, v: KNOB_SHAPES[knob.shape].used(raw, knob.fallback) }).toEqual({ key, raw, v: mod[exported] });
        vi.unstubAllEnvs();
      }
    }
  });

  it("still finds every knob read in the shape the table claims", () => {
    // The table's `site` is load-bearing. Move a knob onto a different helper and the
    // messages here silently start describing a mechanism that no longer runs — the
    // exact failure this whole file exists to prevent, one level up.
    const pattern: Record<string, (k: string) => RegExp> = {
      posInt: (k) => new RegExp(`(posInt|positiveInt)\\(\\s*(process\\.)?env\\.${k}\\b`),
      nonNegInt: (k) => new RegExp(`(nonNegInt|nonNegativeInt)\\(\\s*(process\\.)?env\\.${k}\\b`),
      finiteNonNeg: (k) => new RegExp(`finiteNonNeg\\(\\s*(process\\.)?env\\.${k}\\b`),
    };
    const drifted = NUMERIC_KNOBS.filter(({ key, shape, site }) => {
      const source = readFileSync(new URL(`../../../${site}`, import.meta.url), "utf8");
      return !pattern[shape](key).test(source);
    });
    expect(drifted).toEqual([]);
  });

  /**
   * The INVERSE of the test above, and the gap it cannot cover. A source-shape check
   * iterates the table, so it catches a knob that MOVED to a different helper — but a
   * knob nobody ever listed is invisible to it, and that omission is exactly what let
   * MCP_DEFER_TOKEN_PCT sit in the wrong rule for two releases.
   *
   * So: scan the platform's own sources for reads whose enclosing expression is one of
   * the numeric shapes, and require every name found to be accounted for. The
   * discriminator is the SHAPE, not the name — a knob is numeric because it is read
   * through Number/parseInt/parseFloat or one of the validating helpers.
   *
   * Scoped to `src/` on purpose: the sandbox controller validates its own env in its
   * own process, which is the boundary checkConfig's docblock already draws.
   */
  const CHECKED_ELSEWHERE = new Set(["FORCE_TEXT_AFTER_STEPS", "WRAP_UP_AFTER_FRACTION"]);

  it("has no numeric knob that no rule covers", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p))
      .filter((p) => !p.includes("__tests__") && !p.includes(".test."))
      .map((p) => join("src", p));
    // Comments are stripped first: a docblock that CITES the old `Number(process.env.X)`
    // shape is documentation, not a read, and counting it made this test report a knob
    // named "X". Prose about code must not register as code.
    const source = files
      .map((f) => readFileSync(f, "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const numeric = new Set<string>();
    for (const re of [
      /\bNumber\(\s*process\.env\.([A-Z][A-Z0-9_]*)/g,
      /\bparseInt\(\s*process\.env\.([A-Z][A-Z0-9_]*)/g,
      /\bparseFloat\(\s*process\.env\.([A-Z][A-Z0-9_]*)/g,
      /\b(?:posInt|nonNegInt|finiteNonNeg|positiveInt|nonNegativeInt)\(\s*(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g,
    ]) {
      for (const m of source.matchAll(re)) numeric.add(m[1]);
    }

    // A sanity floor: if the scan finds almost nothing the regexes have drifted, and a
    // vacuous pass here would read exactly like coverage.
    expect(numeric.size).toBeGreaterThan(20);

    const listed = new Set(NUMERIC_KNOBS.map((k) => k.key));
    const unaccounted = [...numeric].filter((k) => !listed.has(k) && !CHECKED_ELSEWHERE.has(k)).sort();
    expect(unaccounted).toEqual([]);
  });

  it("keeps the two exemptions earning their place", () => {
    // An exemption that stops being true keeps passing silently, so assert the reason
    // rather than the name: both are checked, just not by the table, because each has a
    // range the table cannot express — one derived from another knob, one a clamp.
    expect(keysOf({ ...VALID, FORCE_TEXT_AFTER_STEPS: "0" })).toContain("FORCE_TEXT_AFTER_STEPS");
    expect(keysOf({ ...VALID, WRAP_UP_AFTER_FRACTION: "1.5" })).toContain("WRAP_UP_AFTER_FRACTION");
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
