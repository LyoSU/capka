import { describe, it, expect } from "vitest";
import type {
  PublicInstallSurface, PublicSurfaceConnector, PublicSurfaceFiles, PublicSurfaceSkill,
  StoredInstallSurface, StoredSurfaceConnector, StoredSurfaceFiles, StoredSurfaceSkill,
} from "../surface";

/**
 * A COMPILE-time test. `npx tsc --noEmit` covers this file, and a `@ts-expect-error`
 * that fails to error is itself a compile error — so if the projections ever become
 * mutually assignable, the typecheck breaks here.
 *
 * This is the mechanism, not documentation of it. The generic `InstallSurface<C,S,F>`
 * alone is not enough: TypeScript is structurally typed and excess-property checks fire
 * only on fresh object literals, so without the literal `projection` discriminant
 * `const p: PublicSurfaceConnector = someStoredConnector` would compile and a stored
 * value would carry its fingerprint into a client response at runtime.
 */

const stored: StoredSurfaceConnector = {
  projection: "stored", name: "api", originKey: ".mcp.json#api", transport: "http",
  secretKeys: ["Authorization"], needsSecret: true, runsThirdPartyCode: false,
  bundled: false, activation: "forced_disabled",
  execution: { binary: "npx", argCount: 1, placeholderArgs: [], fingerprint: "deadbeef" },
};

const pub: PublicSurfaceConnector = {
  projection: "public", name: "api", originKey: ".mcp.json#api", transport: "http",
  secretKeys: ["Authorization"], needsSecret: true, runsThirdPartyCode: false,
  bundled: false, activation: "forced_disabled",
};

// @ts-expect-error a stored connector must never satisfy a public slot: it carries a
// fingerprint, and a keyed digest confirms a guess about a private plugin's contents.
const leak: PublicSurfaceConnector = stored;

// @ts-expect-error and not the other way either — a public connector has no
// fingerprint, so accepting it as stored would write an incomplete baseline.
const halfBaseline: StoredSurfaceConnector = pub;

// The same must hold for the containers, or the element rule could be bypassed one
// level up by assigning a whole surface.
const storedSurface: StoredInstallSurface = {
  schemaVersion: 1, completeness: "derived", connectors: [stored], skills: [],
  files: { projection: "stored", count: 0, bytes: 0, rootHash: "r", entrypoints: [], files: [] },
};

// @ts-expect-error a stored surface is not a public one, however it is reached.
const surfaceLeak: PublicInstallSurface = storedSurface;

// @ts-expect-error skills split the same way, for the same reason (instructionHash).
const skillLeak: PublicSurfaceSkill = { projection: "stored", name: "w", originPath: "skills/w", instructionHash: "h", filesRootHash: "r" } satisfies StoredSurfaceSkill;

// @ts-expect-error so do file sets — `files[].contentHash` is server-side only.
const filesLeak: PublicSurfaceFiles = { projection: "stored", count: 0, bytes: 0, rootHash: "r", entrypoints: [], files: [] } satisfies StoredSurfaceFiles;

/**
 * NEVER INVOKED. `readonly` exists only in the type system, so running this body would
 * actually flip the discriminant — the proof is that tsc rejects the line, which the
 * `@ts-expect-error` above it asserts.
 */
function neverRun(): void {
  // @ts-expect-error `projection` is readonly on purpose: flipping it in place would
  // turn a stored connector into a public one without dropping the fingerprint.
  pub.projection = "stored";
}

describe("projection typing", () => {
  it("is enforced by tsc, not by this assertion", () => {
    // The values are referenced so lint cannot call them unused; the actual proof is
    // that this file compiles ONLY while every @ts-expect-error above still errors. If
    // the projections became mutually assignable, `npx tsc --noEmit` would fail here
    // with "Unused '@ts-expect-error' directive" — the assertion below would not.
    expect([leak, halfBaseline, surfaceLeak, skillLeak, filesLeak].every(Boolean)).toBe(true);
    expect(neverRun).toBeTypeOf("function");
  });
});
