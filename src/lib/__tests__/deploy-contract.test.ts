import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The contract between the compose files, the scripts, and the code they run.
 *
 * These are deploy-time invariants that no unit test can see and no reviewer
 * reliably re-checks by hand. v0.27.0 shipped because compose on `master` is
 * always newer than the images published on release tags: a new service
 * (`egress-proxy`) started from an image that had no `egress-proxy.js` in it,
 * exited 1, and crash-looped forever behind `restart: unless-stopped`.
 *
 * Every assertion here is a statement the deploy path now depends on.
 */
const COMPOSE = readFileSync("docker-compose.yml", "utf8");
const BUILD = readFileSync("docker-compose.build.yml", "utf8");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");

/** One service's block out of a compose file, comments stripped. */
function serviceBlock(file: string, name: string): string {
  const start = file.indexOf(`\n  ${name}:`);
  expect(start, `service ${name} not found`).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  // Up to the next top-level service key. `:` may be followed by an inline value
  // or a comment, so do not require a newline right after it.
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:/);
  const block = end === -1 ? rest : rest.slice(0, end);
  return block.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
}

/** `image:` reference of a service, verbatim (including the `${...}` parts). */
function imageRef(file: string, name: string): string {
  const m = serviceBlock(file, name).match(/^\s*image:\s*(\S+)/m);
  expect(m, `service ${name} has no image:`).toBeTruthy();
  return m![1];
}

describe("egress-proxy is the controller image under another command", () => {
  /**
   * The capability guard below is only safe because these two are the SAME
   * image: "the proxy file is missing" therefore also means "this controller
   * predates egress routing", so no sandbox is pointed at the proxy and none is
   * left unprotected. Let the two references drift and that reasoning silently
   * stops holding — a new controller could be paired with an old proxy.
   */
  it("references byte-identical image tags", () => {
    expect(imageRef(COMPOSE, "egress-proxy")).toBe(imageRef(COMPOSE, "sandbox-controller"));
  });
});

/**
 * The guard, lifted out of compose and executed for real.
 *
 * Substitutes the probe path and turns the two terminal branches into markers so
 * the script exits instead of running a proxy or idling forever. `$$` is compose's
 * escape for a literal `$` — the container shell sees `$SANDBOX_EGRESS_ALLOW`.
 */
function runGuard({ fileExists, allow }: { fileExists: boolean; allow: string }): { out: string; code: number } {
  const raw = serviceBlock(COMPOSE, "egress-proxy")
    .replace(/^\s*command:\s*$/m, "")
    .split("\n");
  const start = raw.findIndex((l) => l.includes("- |"));
  expect(start, "egress-proxy command is not a block scalar").toBeGreaterThan(-1);
  const end = raw.findIndex((l, i) => i > start && /^\s{4,6}[a-z_]+:/.test(l));
  const script = raw
    .slice(start + 1, end === -1 ? undefined : end)
    .map((l) => l.replace(/^ {8}/, ""))
    .join("\n");

  const dir = mkdtempSync(join(tmpdir(), "capka-guard-"));
  const probe = join(dir, "egress-proxy.js");
  if (fileExists) writeFileSync(probe, "// stub\n");

  // Compose escaping is part of the contract, not an incidental detail: a single
  // `$` would be interpolated by compose on the host (to an empty string, since
  // nothing exports it there) and the container would test a constant. Assert the
  // escape is present, or the un-escaping below would quietly no-op.
  expect(script, "the guard must read $$SANDBOX_EGRESS_ALLOW (compose-escaped)").toContain("$$SANDBOX_EGRESS_ALLOW");
  expect(script).not.toMatch(/(^|[^$])\$SANDBOX_EGRESS_ALLOW/);

  const runnable = script
    .replace(/\$\$/g, "$")
    .replace(/\/app\/egress-proxy\.js/g, probe)
    .replace(/exec node egress-proxy\.js/g, 'echo "MARKER_RUN"; exit 0')
    .replace(/exec tail -f \/dev\/null/g, 'echo "MARKER_IDLE"; exit 0');
  // The script must be exercised as written; a rewrite that matched nothing would
  // make every case below pass for the wrong reason.
  expect(runnable).toContain("MARKER_RUN");
  expect(runnable).toContain("MARKER_IDLE");

  try {
    const out = execFileSync("sh", ["-c", runnable], {
      encoding: "utf8",
      // The one variable the script reads is set explicitly, so an operator's own
      // value in the ambient environment cannot decide which branch is exercised.
      env: { ...process.env, SANDBOX_EGRESS_ALLOW: allow },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? -1 };
  }
}

describe("the egress-proxy capability guard", () => {
  it("runs the proxy when the image has it", () => {
    const { out, code } = runGuard({ fileExists: true, allow: "example.com" });
    expect(out).toContain("MARKER_RUN");
    expect(code).toBe(0);
  });

  it("runs the proxy even with an empty allowlist, so the network and spec stay stable", () => {
    // The service is deliberately always up: the sandbox spec must not change
    // shape the moment an operator fills the list in.
    expect(runGuard({ fileExists: true, allow: "" }).out).toContain("MARKER_RUN");
  });

  it("idles quietly on an older image while no allowlist is set", () => {
    // Nothing is gated, so nothing is lost — and idling (rather than exiting)
    // keeps a master-tracking stack from reading as a failed deployment.
    const { out, code } = runGuard({ fileExists: false, allow: "" });
    expect(out).toContain("MARKER_IDLE");
    expect(out).not.toContain("MARKER_RUN");
    expect(code).toBe(0);
  });

  it("fails loudly on an older image when an allowlist IS set", () => {
    // The operator asked for restricted egress and this stack cannot provide it:
    // the old controller in the same image ignores SANDBOX_EGRESS_ALLOW entirely.
    // Silently idling here would leave them believing egress is restricted.
    const { out, code } = runGuard({ fileExists: false, allow: "example.com" });
    expect(code).not.toBe(0);
    expect(out).not.toContain("MARKER_IDLE");
    expect(out).toMatch(/SANDBOX_EGRESS_ALLOW/);
  });
});

describe("locally built services never pull the tag they just built", () => {
  /**
   * Anything the build overlay compiles must say so with `pull_policy: build`.
   * Two different defaults break this otherwise: the base compose is pull-only
   * and sets `pull_policy: always` on its published images, and where the base
   * has no block at all, compose's own default still reaches for the registry
   * when the tag is not local. Either way a bare `docker compose -f ... -f
   * docker-compose.build.yml up` runs a released image instead of the one just
   * built, and the only thing preventing it is the caller remembering `--build`.
   */
  const built = [...BUILD.matchAll(/\n {2}([a-z][a-z0-9_-]*):/g)]
    .map((m) => m[1])
    .filter((name) => /^\s*build:/m.test(serviceBlock(BUILD, name)));

  it("finds the services the overlay builds", () => {
    expect(built).toEqual(expect.arrayContaining(["platform", "sandbox-controller", "egress-proxy", "sandbox"]));
  });

  // Unconditional, including `sandbox`, which the base file has no block for:
  // the invariant is not "override the base" but "a service built here is never
  // fetched", and compose's own default (pull when the tag is not local) breaks
  // it just as effectively as an inherited `always`.
  it.each(built)("%s sets pull_policy: build in the overlay", (name) => {
    expect(serviceBlock(BUILD, name)).toMatch(/^\s*pull_policy:\s*build\s*$/m);
  });
});

describe("up.sh's one-shot list matches the compose files", () => {
  /**
   * `unhealthy_services()` forgives a service that exited 0 only if it is a
   * declared one-shot. That list lives in the shell script and the policy lives
   * in compose, so nothing but this test connects them: add a `restart: "no"`
   * service and forget the script, and its failures get reported as failures
   * (fine); add a long-running service to the script and its clean exit becomes
   * invisible (not fine).
   */
  const UP = readFileSync("scripts/up.sh", "utf8");
  const declared = (UP.match(/^ONE_SHOTS="([^"]*)"/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
  // Every compose file an operator can layer, not just the ones up.sh layers by
  // itself: a one-shot added to the backup overlay would otherwise be reported as
  // a broken service on every stack that runs it.
  const FILES = readdirSync(".")
    .filter((f) => /^docker-compose(\.[a-z]+)?\.yml$/.test(f))
    .map((f) => [f, readFileSync(f, "utf8")] as const);

  it("scans every compose overlay in the repo", () => {
    const names = FILES.map(([f]) => f);
    expect(names).toEqual(expect.arrayContaining(["docker-compose.yml", "docker-compose.backup.yml"]));
  });

  it("declares the one-shots it forgives", () => {
    expect(declared).toEqual(["db-init", "sandbox"]);
  });

  it.each(declared)("%s exists and is not a long-running service", (name) => {
    const blocks = FILES.filter(([, body]) => body.includes(`\n  ${name}:`)).map(([, body]) => serviceBlock(body, name));
    expect(blocks.length, `${name} is forgiven by up.sh but is not a service in any compose file`).toBeGreaterThan(0);
    for (const block of blocks) expect(block).not.toMatch(/^\s*restart:\s*unless-stopped/m);
  });

  it("forgives every service compose marks restart: \"no\"", () => {
    const oneShots = new Set<string>();
    for (const [, body] of FILES) {
      for (const m of body.matchAll(/\n {2}([a-z][a-z0-9_-]*):/g)) {
        if (/^\s*restart:\s*"?no"?\s*$/m.test(serviceBlock(body, m[1]))) oneShots.add(m[1]);
      }
    }
    const missing = [...oneShots].filter((n) => !declared.includes(n));
    expect(missing, `restart: "no" in compose but not in up.sh's ONE_SHOTS: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("every documented knob reaches the container that reads it", () => {
  /**
   * `environment:` is an explicit whitelist: a variable in the operator's `.env`
   * reaches compose but NOT the container unless it is named. A knob documented
   * in `.env.example` and then not passed through is a silent no-op — the
   * operator sets it, nothing happens, and nothing says so. v0.27.0 shipped with
   * three of them (SANDBOX_CPUS, SANDBOX_BUSY_LEASE_MS, SANDBOX_BUSY_MAX_MS).
   */
  const documented = new Set(
    [...ENV_EXAMPLE.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]),
  );

  /** Env names read by a set of source files. */
  function envRead(files: string[]): Set<string> {
    const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const names = [
      ...[...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
      // The env helpers take the name as a string: posIntEnv("SANDBOX_CPUS", …).
      ...[...src.matchAll(/(?:posInt|posFloat|int)Env\(\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
    ];
    return new Set(names);
  }

  const controllerSources = readdirSync("sandbox-controller", { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".js"))
    .filter((p) => !p.includes("node_modules") && !p.endsWith(".test.js") && !p.endsWith("egress-proxy.js"))
    .map((p) => join("sandbox-controller", p));

  it("collects controller sources", () => {
    expect(controllerSources.length).toBeGreaterThan(5);
  });

  it("passes every documented controller knob into sandbox-controller", () => {
    const passed = serviceBlock(COMPOSE, "sandbox-controller");
    const missing = [...envRead(controllerSources)]
      .filter((n) => documented.has(n))
      .filter((n) => !new RegExp(`^\\s*- ${n}=`, "m").test(passed));
    expect(missing, `documented in .env.example but not passed to sandbox-controller: ${missing.join(", ")}`).toEqual([]);
  });

  it("passes every documented proxy knob into egress-proxy", () => {
    const passed = serviceBlock(COMPOSE, "egress-proxy");
    const missing = [...envRead(["sandbox-controller/egress-proxy.js"])]
      .filter((n) => documented.has(n))
      .filter((n) => !new RegExp(`^\\s*- ${n}=`, "m").test(passed));
    expect(missing, `documented in .env.example but not passed to egress-proxy: ${missing.join(", ")}`).toEqual([]);
  });
});
