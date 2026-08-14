import { describe, it, expect } from "vitest";
import { classifyDelta, type DeltaEntry } from "../delta";
import { normalizeEndpoint } from "../canonical";
import type { StoredInstallSurface, StoredSurfaceConnector, StoredSurfaceSkill } from "../surface";

const conn = (over: Partial<StoredSurfaceConnector> = {}): StoredSurfaceConnector => ({
  projection: "stored", name: "api", originKey: ".mcp.json#api", transport: "http",
  endpoint: normalizeEndpoint("https://api.example.com/read")!,
  authKind: "token", secretKeys: ["Authorization"], needsSecret: false,
  runsThirdPartyCode: false, bundled: false, activation: "left_as_is", ...over,
});

const skill = (over: Partial<StoredSurfaceSkill> = {}): StoredSurfaceSkill => ({
  projection: "stored", name: "writer", originPath: "skills/writer",
  instructionHash: "i1", bodyHash: "b1", filesRootHash: "f1", ...over,
});

const surface = (over: Partial<StoredInstallSurface> = {}): StoredInstallSurface => ({
  schemaVersion: 1, completeness: "derived", connectors: [], skills: [],
  files: { projection: "stored", count: 0, bytes: 0, rootHash: "empty", entrypoints: [], files: [] },
  ...over,
});

/** Same artifact on both axes — the ordinary case where nothing was edited locally. */
const both = (before: StoredInstallSurface, after: StoredInstallSurface, urls: Record<string, "allowed"> = {}) =>
  classifyDelta({ sourceBefore: before, runtimeBefore: before, sourceAfter: after, urls });

const find = (entries: DeltaEntry[], key: string) => entries.find((e) => e.key === key)!;

describe("the six kinds partition by identity", () => {
  it("unchanged: a byte-identical resource", () => {
    const d = both(surface({ connectors: [conn()] }), surface({ connectors: [conn()] }));
    expect(d.kinds).toEqual(["unchanged"]);
    expect(d.gate).toBe("no_consent");
  });

  it("expansion: a resource that did not exist", () => {
    const d = both(surface(), surface({ connectors: [conn()] }));
    expect(find(d.effective, ".mcp.json#api").kind).toBe("expansion");
    expect(d.gate).toBe("requires_consent");
  });

  it("removal: a resource gone from the new surface, and it needs no consent", () => {
    const d = both(surface({ connectors: [conn()] }), surface());
    expect(find(d.effective, ".mcp.json#api").kind).toBe("removal");
    expect(d.gate).toBe("no_consent");
  });

  it("replacement: any other difference in a resource that exists on both sides", () => {
    const d = both(surface({ connectors: [conn()] }),
      surface({ connectors: [conn({ endpoint: normalizeEndpoint("https://api.example.com/admin")! })] }));
    expect(find(d.effective, ".mcp.json#api")).toMatchObject({ kind: "replacement", aspects: ["endpoint"] });
    expect(d.gate).toBe("requires_consent");
  });

  it("attenuation: ONLY an enabled row being forced off, otherwise byte-identical", () => {
    const d = classifyDelta({
      sourceBefore: surface({ connectors: [conn()] }),
      runtimeBefore: surface({ connectors: [conn({ activation: "enabled" })] }),
      sourceAfter: surface({ connectors: [conn({ activation: "forced_disabled" })] }),
      urls: {},
    });
    expect(find(d.effective, ".mcp.json#api")).toMatchObject({ kind: "attenuation", aspects: ["activation"] });
    expect(d.gate).toBe("no_consent");
  });

  it("unknown: no baseline could be established, which is not the same as no change", () => {
    const d = classifyDelta({
      sourceBefore: null, runtimeBefore: null, sourceAfter: surface({ connectors: [conn()] }), urls: {},
    });
    expect(d.kinds).toEqual(["unknown"]);
    expect(d.gate).toBe("requires_consent");
  });

  it("does not let a resource fall into two kinds at once", () => {
    // A removed resource used to be reported as BOTH attenuation and removal. Keying on
    // identity means every resource appears exactly once per axis.
    const d = both(surface({ connectors: [conn({ activation: "enabled" })] }), surface());
    const hits = d.effective.filter((e) => e.key === ".mcp.json#api");
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("removal");
  });
});

describe("attenuation is narrow on purpose", () => {
  it("is NOT attenuation when the resource also changed", () => {
    // Turning something off while also repointing it is a change to read, not a
    // reduction to wave through.
    const d = classifyDelta({
      sourceBefore: surface({ connectors: [conn()] }),
      runtimeBefore: surface({ connectors: [conn({ activation: "enabled" })] }),
      sourceAfter: surface({ connectors: [conn({ activation: "forced_disabled", endpoint: normalizeEndpoint("https://elsewhere.example/mcp")! })] }),
      urls: {},
    });
    expect(find(d.effective, ".mcp.json#api").kind).toBe("replacement");
    expect(d.gate).toBe("requires_consent");
  });

  it("is NOT attenuation when the row was already disabled", () => {
    // Nothing is being taken away, so there is nothing to attenuate; the pair is simply
    // unchanged as an artifact.
    const d = classifyDelta({
      sourceBefore: surface({ connectors: [conn()] }),
      runtimeBefore: surface({ connectors: [conn({ activation: "disabled" })] }),
      sourceAfter: surface({ connectors: [conn({ activation: "forced_disabled" })] }),
      urls: {},
    });
    expect(find(d.effective, ".mcp.json#api").kind).toBe("unchanged");
  });
});

describe("changes that must not read as reductions", () => {
  it("treats needsSecret true → false as a replacement, not an improvement", () => {
    // AMBIGUOUS, and ambiguity is exactly what must not be waved through: it may mean
    // the endpoint no longer needs a key, or that the plugin dropped the feature that
    // used it. This is the guard against reading "fewer" as "weaker".
    const d = both(surface({ connectors: [conn({ needsSecret: true })] }),
      surface({ connectors: [conn({ needsSecret: false })] }));
    expect(find(d.effective, ".mcp.json#api")).toMatchObject({ kind: "replacement", aspects: ["credential"] });
    expect(d.gate).toBe("requires_consent");
  });

  it("catches https → http", () => {
    const d = both(surface({ connectors: [conn()] }),
      surface({ connectors: [conn({ endpoint: normalizeEndpoint("http://api.example.com/read")! })] }));
    expect(find(d.effective, ".mcp.json#api").aspects).toEqual(["endpoint"]);
  });

  it("catches a port change on the same host and path", () => {
    const d = both(surface({ connectors: [conn()] }),
      surface({ connectors: [conn({ endpoint: normalizeEndpoint("https://api.example.com:8443/read")! })] }));
    expect(find(d.effective, ".mcp.json#api").aspects).toEqual(["endpoint"]);
  });

  it("catches a switch to OAuth", () => {
    const d = both(surface({ connectors: [conn()] }), surface({ connectors: [conn({ authKind: "oauth" })] }));
    expect(find(d.effective, ".mcp.json#api").aspects).toEqual(["credential"]);
  });

  it("catches a same-length command-line edit through the fingerprint", () => {
    // argCount and placeholderArgs are identical; only the keyed digest differs. That
    // is the case a shape-only comparison would miss.
    const stdio = (fp: string) => conn({
      name: "gh", originKey: ".mcp.json#gh", transport: "stdio", endpoint: undefined, authKind: undefined,
      runsThirdPartyCode: true, secretKeys: [], activation: "forced_disabled",
      execution: { binary: "npx", argCount: 2, placeholderArgs: [], fingerprint: fp },
    });
    const d = both(surface({ connectors: [stdio("aaa")] }), surface({ connectors: [stdio("bbb")] }));
    expect(find(d.effective, ".mcp.json#gh")).toMatchObject({ kind: "replacement", aspects: ["command"] });
  });

  it("catches a credential value swapped under an UNCHANGED header name", () => {
    // This read as `unchanged` / `no_consent` until the stored surface gained a fingerprint
    // over the raw url and headers: the endpoint is redacted and `secretKeys` holds only
    // names, so `Authorization: Bearer old → new` produced a byte-identical surface. A plugin
    // could silently repoint where your token goes.
    const d = both(surface({ connectors: [conn({ credentialFingerprint: "fp-old" })] }),
      surface({ connectors: [conn({ credentialFingerprint: "fp-new" })] }));
    expect(find(d.effective, ".mcp.json#api")).toMatchObject({ kind: "replacement", aspects: ["credential"] });
    expect(d.gate).toBe("requires_consent");
  });

  it("catches a skill body edited in the DATABASE, not just upstream", () => {
    // `instructionHash` is over the raw SKILL.md, which the row does not keep — so a locally
    // modified or prompt-injected body was invisible on the runtime axis until `bodyHash`
    // gave that axis something it can actually compute.
    const d = classifyDelta({
      sourceBefore: surface({ skills: [skill()] }),
      runtimeBefore: surface({ skills: [skill({ bodyHash: "tampered" })] }),
      sourceAfter: surface({ skills: [skill()] }),
      urls: {},
    });
    expect(find(d.upstream, "writer").kind).toBe("unchanged");
    expect(find(d.effective, "writer")).toMatchObject({ kind: "replacement", aspects: ["instructions"] });
    expect(d.gate).toBe("requires_consent");
  });

  it("catches a rewritten SKILL.md and a changed bundled file separately", () => {
    const d = both(surface({ skills: [skill()] }), surface({ skills: [skill({ instructionHash: "i2" })] }));
    expect(find(d.effective, "writer")).toMatchObject({ kind: "replacement", aspects: ["instructions"] });

    const f = both(surface({ skills: [skill()] }), surface({ skills: [skill({ filesRootHash: "f2" })] }));
    expect(find(f.effective, "writer").aspects).toEqual(["files"]);
  });

  it("catches a same-size swap in the bundled tree", () => {
    const files = (rootHash: string) => ({
      projection: "stored" as const, count: 1, bytes: 3, rootHash, entrypoints: [],
      files: [{ path: "run.sh", bytes: 3, contentHash: rootHash }],
    });
    const d = both(surface({ files: files("r1") }), surface({ files: files("r2") }));
    expect(find(d.effective, "files")).toMatchObject({ kind: "replacement", aspects: ["files"] });
  });

  it("says nothing about two empty file trees even if their placeholder hashes differ", () => {
    // A reconstructed baseline need not have computed the empty-tree hash the same way,
    // and a spurious "files removed" row teaches a reader to skim past rows that matter.
    const d = both(
      surface({ files: { projection: "stored", count: 0, bytes: 0, rootHash: "legacy-placeholder", entrypoints: [], files: [] } }),
      surface());
    expect(d.effective.filter((e) => e.resource === "files")).toEqual([]);
  });

  it("reads a rename as removal plus expansion, so the expansion half gates it", () => {
    // No provable rename is needed for SAFETY: originKey is the manifest path plus the
    // server key, and the server name IS that key, so a rename changes it.
    const d = both(surface({ connectors: [conn({ name: "old", originKey: ".mcp.json#old" })] }),
      surface({ connectors: [conn({ name: "new", originKey: ".mcp.json#new" })] }));
    expect(new Set(d.kinds)).toEqual(new Set(["removal", "expansion"]));
    expect(d.gate).toBe("requires_consent");
  });
});

describe("the two axes", () => {
  it("gates on `effective`, since that is what applying would overwrite", () => {
    // Upstream changed nothing; the RUNTIME differs because an admin edited the row by
    // hand. Applying would overwrite that edit, so consent is required even though the
    // author shipped nothing new.
    const d = classifyDelta({
      sourceBefore: surface({ connectors: [conn()] }),
      runtimeBefore: surface({ connectors: [conn({ endpoint: normalizeEndpoint("https://internal.example/read")! })] }),
      sourceAfter: surface({ connectors: [conn()] }),
      urls: {},
    });
    expect(find(d.upstream, ".mcp.json#api").kind).toBe("unchanged");
    expect(find(d.effective, ".mcp.json#api").kind).toBe("replacement");
    expect(d.gate).toBe("requires_consent");
  });

  it("reports kinds as a set, because one upgrade can be several things at once", () => {
    const d = both(
      surface({ connectors: [conn({ originKey: ".mcp.json#gone", name: "gone" })], skills: [skill()] }),
      surface({ connectors: [conn({ originKey: ".mcp.json#fresh", name: "fresh" })], skills: [skill()] }));
    expect(d.kinds).toContain("expansion");
    expect(d.kinds).toContain("removal");
    expect(d.kinds).toContain("unchanged");
  });
});

describe("cannot_apply", () => {
  it("outranks a delta that would otherwise need no consent", () => {
    // The review may be perfectly valid and the artifact unchanged; there is still
    // nothing safe to apply.
    const d = both(surface({ connectors: [conn()] }), surface({ connectors: [conn()] }),
      { api: "allowed" });
    expect(d.gate).toBe("no_consent");

    const blocked = classifyDelta({
      sourceBefore: surface({ connectors: [conn()] }), runtimeBefore: surface({ connectors: [conn()] }),
      sourceAfter: surface({ connectors: [conn()] }), urls: { api: "blocked" },
    });
    expect(blocked.gate).toBe("cannot_apply");
  });

  it("treats unresolved and invalid as fail-closed too", () => {
    for (const verdict of ["unresolved", "invalid"] as const) {
      const d = classifyDelta({
        sourceBefore: surface(), runtimeBefore: surface(), sourceAfter: surface({ connectors: [conn()] }),
        urls: { api: verdict },
      });
      expect(d.gate).toBe("cannot_apply");
    }
  });
});

describe("stability", () => {
  it("orders entries deterministically, because the delta is part of what is consented to", () => {
    const before = surface();
    const after = surface({
      connectors: [conn({ originKey: ".mcp.json#z", name: "z" }), conn({ originKey: ".mcp.json#a", name: "a" })],
      skills: [skill({ name: "b" }), skill({ name: "a" })],
    });
    const keys = (d: ReturnType<typeof classifyDelta>) => d.effective.map((e) => `${e.resource}:${e.key}`);
    expect(keys(both(before, after))).toEqual(keys(both(before, after)));
    expect(keys(both(before, after))).toEqual([
      "connector:.mcp.json#a", "connector:.mcp.json#z", "skill:a", "skill:b",
    ]);
  });
});
