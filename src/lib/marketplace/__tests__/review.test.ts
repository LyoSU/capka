import { describe, it, expect } from "vitest";
import { projectPluginReview, reviewHash, type ReviewSubject } from "../review";
import { classifyDelta } from "../delta";
import { normalizeEndpoint } from "../canonical";
import type { ReviewObservations } from "../observe";
import type { ResolvedPluginPlan } from "../plan";
import type { StoredInstallSurface, StoredSurfaceConnector } from "../surface";

const conn = (over: Partial<StoredSurfaceConnector> = {}): StoredSurfaceConnector => ({
  projection: "stored", name: "api", originKey: ".mcp.json#api", transport: "http",
  endpoint: normalizeEndpoint("https://api.example.com/mcp")!,
  authKind: "token", secretKeys: [], needsSecret: false,
  runsThirdPartyCode: false, bundled: false, activation: "left_as_is", ...over,
});

const surface = (over: Partial<StoredInstallSurface> = {}): StoredInstallSurface => ({
  schemaVersion: 1, completeness: "derived", connectors: [conn()], skills: [],
  files: { projection: "stored", count: 0, bytes: 0, rootHash: "r", entrypoints: [], files: [] },
  ...over,
});

const SUBJECT: ReviewSubject = {
  kind: "upgrade", installId: "i1", marketplaceId: "mk1", pluginName: "plug",
  scope: "system", ownerId: null, targetSha: "a".repeat(40), only: null, skillsOnly: false,
};

const OBS: ReviewObservations = {
  urls: { api: "allowed" }, detectedAuth: { api: "token" },
  policy: { blockPrivate: false }, observedAt: "2026-08-14T00:00:00.000Z",
};

const base = {
  subject: SUBJECT, sourceBefore: surface(), runtimeBefore: surface(), sourceAfter: surface(),
  observations: OBS, dispositions: {}, policyRevisions: {},
};

describe("reviewHash covers every input the decision depends on", () => {
  it("is stable for identical inputs", () => {
    expect(reviewHash(base)).toBe(reviewHash(base));
  });

  it("changes when the artifact changes", () => {
    expect(reviewHash({ ...base, sourceAfter: surface({ connectors: [conn({ needsSecret: true })] }) }))
      .not.toBe(reviewHash(base));
  });

  it("changes when either baseline moves", () => {
    // Both axes matter: `upstream` is what the author changed, `effective` is what an
    // apply would overwrite, and a consent was given against both.
    expect(reviewHash({ ...base, sourceBefore: null })).not.toBe(reviewHash(base));
    expect(reviewHash({ ...base, runtimeBefore: surface({ connectors: [conn({ activation: "enabled" })] }) }))
      .not.toBe(reviewHash(base));
  });

  it("changes when a preflight verdict or an applied auth kind changes", () => {
    expect(reviewHash({ ...base, observations: { ...OBS, urls: { api: "blocked" } } })).not.toBe(reviewHash(base));
    expect(reviewHash({ ...base, observations: { ...OBS, detectedAuth: { api: "oauth" } } })).not.toBe(reviewHash(base));
  });

  it("changes when the subject narrows to skills only", () => {
    // Not decoration: `skillsOnly` changes which resources `buildPluginPlan` returns. Outside
    // the hash, a review built for a bare skills repo — whose approval card promises skills and
    // nothing else — would authorize an apply that also installed the repo's `.mcp.json`
    // connector and its bundled, executable plugin files.
    expect(reviewHash({ ...base, subject: { ...SUBJECT, skillsOnly: true } })).not.toBe(reviewHash(base));
  });

  it("changes when the private-range policy changes", () => {
    // The same URL is allowed on one instance and refused on another, so a verdict
    // computed under a different policy is a different fact.
    expect(reviewHash({ ...base, observations: { ...OBS, policy: { blockPrivate: true } } }))
      .not.toBe(reviewHash(base));
  });

  it("does NOT change when only the observation timestamp moves", () => {
    // A review must not expire because time passed, and a timestamp in the hash would
    // make it unreproducible by construction — the apply recomputes observations and
    // would never match.
    expect(reviewHash({ ...base, observations: { ...OBS, observedAt: "2027-01-01T00:00:00.000Z" } }))
      .toBe(reviewHash(base));
  });

  it("covers policy dispositions and the revisions they were computed against", () => {
    // Otherwise the installer consents to one policy outcome and the apply performs
    // another.
    expect(reviewHash({ ...base, dispositions: { "connector:api": "delete" } })).not.toBe(reviewHash(base));
    // And the wider baseline: the policy tables are not plugin-owned, so a hand edit is
    // not fenced. It shows up as a stale baseline instead, caught by the second check.
    expect(reviewHash({ ...base, policyRevisions: { "system:connector:api::": 4 } }))
      .not.toBe(reviewHash({ ...base, policyRevisions: { "system:connector:api::": 5 } }));
  });
});

describe("a review cannot be replayed against a different subject", () => {
  const vary = (over: Partial<ReviewSubject>) => reviewHash({ ...base, subject: { ...SUBJECT, ...over } });

  it("is bound to operation kind, install, marketplace, plugin, scope, owner, SHA and `only`", () => {
    const baseline = reviewHash(base);
    expect(vary({ kind: "install" })).not.toBe(baseline);
    expect(vary({ installId: "i2" })).not.toBe(baseline);
    expect(vary({ marketplaceId: "mk2" })).not.toBe(baseline);
    expect(vary({ pluginName: "other" })).not.toBe(baseline);
    expect(vary({ scope: "user", ownerId: "u1" })).not.toBe(baseline);
    expect(vary({ ownerId: "u2" })).not.toBe(baseline);
    expect(vary({ targetSha: "b".repeat(40) })).not.toBe(baseline);
    // A review of two skills must not authorize an apply of twenty.
    expect(vary({ only: ["one"] })).not.toBe(baseline);
    expect(vary({ only: ["one", "two"] })).not.toBe(vary({ only: ["one"] }));
  });

  it("treats `only` as a set, so listing the same skills in another order is one review", () => {
    expect(vary({ only: ["a", "b"] })).toBe(vary({ only: ["b", "a"] }));
  });
});

describe("projectPluginReview", () => {
  const plan: ResolvedPluginPlan = {
    commit: { sha: "a".repeat(40), date: null, message: null },
    connectors: [{ name: "gh", originKey: ".mcp.json#gh", kind: "stdio", command: "npx",
                   args: ["--token", "t0psecret"], bundled: false, envUnresolved: false, hasPlaceholder: false }],
    skills: [], ignored: [], notes: ["a note"], files: [], needsFiles: false,
  };
  const delta = classifyDelta({ sourceBefore: surface(), runtimeBefore: surface(), sourceAfter: surface(), urls: OBS.urls });
  const out = () => projectPluginReview({ ...base, plan, delta });

  it("gives all three projections the same hash and gate", () => {
    const { response, durable } = out();
    expect(response.reviewHash).toBe(durable.reviewHash);
    expect(response.gate).toBe(durable.gate);
    expect(response.gate).toBe(delta.gate);
  });

  it("puts a literal command line in the ephemeral response and NOWHERE else", () => {
    const { response, durable, storedAfter } = out();
    expect(response.execution).toEqual([{ connectorName: "gh", command: "npx", args: ["--token", "t0psecret"] }]);
    // The durable projection has no field that could hold it — this assertion is the
    // runtime half of a guarantee the TYPE already makes: insertPluginAudit accepts only
    // a DurablePluginReview.
    expect(JSON.stringify(durable)).not.toContain("t0psecret");
    expect(JSON.stringify(storedAfter)).not.toContain("t0psecret");
    expect(durable).not.toHaveProperty("execution");
  });

  it("carries the public surface, never the stored one", () => {
    const stdio = surface({ connectors: [conn({
      transport: "stdio", endpoint: undefined, authKind: undefined, runsThirdPartyCode: true,
      execution: { binary: "npx", argCount: 2, placeholderArgs: [], fingerprint: "deadbeef" },
    })] });
    const { response, durable } = projectPluginReview({ ...base, sourceAfter: stdio, plan, delta });
    for (const projection of [response.surface, durable.surface]) {
      expect(projection.connectors[0].projection).toBe("public");
      expect(JSON.stringify(projection)).not.toContain("deadbeef");
    }
  });

  it("returns the artifact surface as the next baseline, unchanged", () => {
    expect(out().storedAfter).toEqual(base.sourceAfter);
  });
});
