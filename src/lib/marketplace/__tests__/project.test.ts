import { describe, it, expect } from "vitest";
import { ephemeralExecutionDetails, projectPlanSurface, toPublicSurface } from "../project";
import type { ReviewObservations } from "../observe";
import type { ResolvedPluginPlan } from "../plan";

const KEY = "a".repeat(64);

const OBS: ReviewObservations = {
  urls: {}, detectedAuth: {}, policy: { blockPrivate: false }, observedAt: "2026-08-14T00:00:00.000Z",
};

const plan = (over: Partial<ResolvedPluginPlan> = {}): ResolvedPluginPlan => ({
  commit: { sha: "c".repeat(40), date: null, message: null },
  connectors: [], skills: [], ignored: [], notes: [], files: [], needsFiles: false, ...over,
});

const stdio = (over: Partial<ResolvedPluginPlan["connectors"][number]> = {}) => ({
  name: "gh", originKey: ".mcp.json#gh", kind: "stdio" as const, command: "npx",
  args: ["-y", "server"], bundled: false, envUnresolved: false, hasPlaceholder: false, ...over,
});

const remote = (over: Partial<ResolvedPluginPlan["connectors"][number]> = {}) => ({
  name: "api", originKey: ".mcp.json#api", kind: "remote" as const, url: "https://api.example.com/mcp",
  bundled: false, envUnresolved: false, hasPlaceholder: false, ...over,
});

describe("projectPlanSurface — no value ever reaches a stored projection", () => {
  it("keeps an env value out of the surface while keeping its NAME", async () => {
    const surface = projectPlanSurface(
      plan({ connectors: [stdio({ env: { GITHUB_TOKEN: "ghp_realsecret", NODE_ENV: "production" } })] }), OBS, KEY);
    const json = JSON.stringify(surface);
    expect(json).not.toContain("ghp_realsecret");
    expect(json).not.toContain("production");
    expect(surface.connectors[0].secretKeys).toEqual(["GITHUB_TOKEN", "NODE_ENV"]);
  });

  it("keeps an argument's contents out while recording the shape", async () => {
    const surface = projectPlanSurface(
      plan({ connectors: [stdio({ args: ["--token", "t0psecret", "--url", "${API_URL}"] })] }), OBS, KEY);
    expect(JSON.stringify(surface)).not.toContain("t0psecret");
    expect(surface.connectors[0].execution).toMatchObject({
      binary: "npx", argCount: 4, placeholderArgs: [3],
    });
  });

  it("keeps a header value and URL credentials out of the endpoint", async () => {
    const surface = projectPlanSurface(plan({
      connectors: [remote({ url: "https://u:pw@api.example.com/mcp?key=sekret", headers: { Authorization: "Bearer live" } })],
    }), OBS, KEY);
    const json = JSON.stringify(surface);
    for (const leak of ["pw", "sekret", "Bearer live", "live"]) expect(json).not.toContain(leak);
    expect(surface.connectors[0].endpoint).toEqual({
      scheme: "https", host: "api.example.com", port: 443, pathname: "/mcp", queryKeys: ["key"],
    });
    expect(surface.connectors[0].secretKeys).toEqual(["Authorization"]);
  });
});

describe("projectPlanSurface — what the install would actually do", () => {
  it("marks every stdio connector as third-party code forced off", async () => {
    const surface = projectPlanSurface(plan({ connectors: [stdio()] }), OBS, KEY);
    expect(surface.connectors[0]).toMatchObject({
      transport: "stdio", runsThirdPartyCode: true, activation: "forced_disabled", needsSecret: false,
    });
  });

  it("leaves a complete remote connector's activation alone", async () => {
    // upsertServer's update path does not touch `enabled`, so an artifact surface can
    // never claim an install turns something ON.
    const surface = projectPlanSurface(plan({ connectors: [remote()] }), OBS, KEY);
    expect(surface.connectors[0]).toMatchObject({ activation: "left_as_is", runsThirdPartyCode: false });
  });

  it("forces off a remote connector that still needs a key", async () => {
    const surface = projectPlanSurface(
      plan({ connectors: [remote({ headers: { Authorization: "Bearer ${T}" }, hasPlaceholder: true })] }), OBS, KEY);
    expect(surface.connectors[0]).toMatchObject({ activation: "forced_disabled", needsSecret: true });
  });

  it("carries the auth kind the install would persist, not a default", async () => {
    const surface = projectPlanSurface(plan({ connectors: [remote()] }),
      { ...OBS, detectedAuth: { api: "oauth" } }, KEY);
    expect(surface.connectors[0].authKind).toBe("oauth");
  });

  it("reports the transport the row would get, inferred the same way the service infers it", async () => {
    const surface = projectPlanSurface(
      plan({ connectors: [remote({ url: "https://api.example.com/sse" })] }), OBS, KEY);
    expect(surface.connectors[0].transport).toBe("sse");
  });

  it("names an entrypoint only when the command lands inside the plugin root", async () => {
    // Parity with plugin-runtime.ts, which chmods exactly `spec.command` and only when
    // it resolves inside the base dir. A bare `npx` makes nothing executable.
    const bundled = projectPlanSurface(plan({
      connectors: [stdio({ command: "${CLAUDE_PLUGIN_ROOT}/bin/run.sh", bundled: true })],
      files: [{ path: "bin/run.sh", content: Buffer.from("#!/bin/sh\n").toString("base64") }],
    }), OBS, KEY);
    expect(bundled.files.entrypoints).toEqual(["bin/run.sh"]);
    expect(projectPlanSurface(plan({ connectors: [stdio()] }), OBS, KEY).files.entrypoints).toEqual([]);
  });

  it("is byte-identical for one plan, and orders by identity not by input order", async () => {
    // The stored surface is what a later upgrade compares against, so an unstable order
    // would read as a plugin change on every apply.
    const p = plan({
      connectors: [remote({ name: "z", originKey: ".mcp.json#z" }), stdio({ name: "a", originKey: ".mcp.json#a" })],
      skills: [
        { name: "w2", originPath: "skills/w2", raw: "b", parsed: { name: "w2", description: undefined, body: "b", frontmatter: {} }, files: [] },
        { name: "w1", originPath: "skills/w1", raw: "a", parsed: { name: "w1", description: undefined, body: "a", frontmatter: {} }, files: [] },
      ],
    });
    const a = projectPlanSurface(p, OBS, KEY);
    expect(a).toEqual(projectPlanSurface(p, OBS, KEY));
    expect(a.connectors.map((c) => c.originKey)).toEqual([".mcp.json#a", ".mcp.json#z"]);
    expect(a.skills.map((s) => s.name)).toEqual(["w1", "w2"]);
  });

  it("hashes the RAW skill file, so a frontmatter-only edit is a change", async () => {
    const mk = (raw: string) => projectPlanSurface(plan({ skills: [
      { name: "w", originPath: "skills/w", raw, parsed: { name: "w", description: undefined, body: "Body", frontmatter: {} }, files: [] },
    ] }), OBS, KEY).skills[0].instructionHash;
    // Same body, different frontmatter: hashing `parsed.body` would call these equal,
    // and frontmatter is where a skill's description and wiring live.
    expect(mk("---\nname: w\n---\nBody")).not.toBe(mk("---\nname: w\ndescription: new\n---\nBody"));
  });
});

describe("toPublicSurface", () => {
  it("drops every hash and fingerprint", async () => {
    const stored = projectPlanSurface(plan({
      connectors: [stdio({ env: { T: "${X}" } })],
      skills: [{ name: "w", originPath: "skills/w", raw: "r", parsed: { name: "w", description: undefined, body: "r", frontmatter: {} }, files: [] }],
      files: [{ path: "a.txt", content: Buffer.from("x").toString("base64") }],
    }), OBS, KEY);
    const pub = toPublicSurface(stored);
    const json = JSON.stringify(pub);

    // Named explicitly rather than by regex: a keyed digest is a confirmation oracle,
    // so each one has to be shown absent, not merely unlikely to appear.
    expect(json).not.toContain(stored.connectors[0].execution!.fingerprint);
    expect(json).not.toContain(stored.skills[0].instructionHash);
    expect(json).not.toContain(stored.skills[0].filesRootHash);
    expect(json).not.toContain(stored.files.rootHash);
    expect(json).not.toContain(stored.files.files[0].contentHash);
    expect(pub.files).not.toHaveProperty("files");
  });

  it("keeps the execution shape, because that is what the review is about", async () => {
    const pub = toPublicSurface(projectPlanSurface(
      plan({ connectors: [stdio({ args: ["-y", "${T}"] })] }), OBS, KEY));
    expect(pub.connectors[0].execution).toEqual({ binary: "npx", argCount: 2, placeholderArgs: [1] });
  });
});

describe("ephemeralExecutionDetails", () => {
  it("is the only place a literal command line leaves the plan", async () => {
    const p = plan({ connectors: [stdio({ args: ["--token", "t0psecret"] }), remote()] });
    expect(ephemeralExecutionDetails(p)).toEqual([
      { connectorName: "gh", command: "npx", args: ["--token", "t0psecret"] },
    ]);
    // And it is reached by an explicit call, so it cannot ride along into a stored or
    // public projection by accident.
    expect(JSON.stringify(toPublicSurface(projectPlanSurface(p, OBS, KEY)))).not.toContain("t0psecret");
  });
});
