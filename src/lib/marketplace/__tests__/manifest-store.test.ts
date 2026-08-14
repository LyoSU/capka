import { describe, it, expect } from "vitest";
import { readStoredManifest, writeStoredManifest } from "../manifest-store";
import type { StoredInstallSurface } from "../surface";

const surface: StoredInstallSurface = {
  schemaVersion: 1, completeness: "derived", connectors: [], skills: [],
  files: { projection: "stored", count: 0, bytes: 0, rootHash: "r", entrypoints: [], files: [] },
};

const legacy = {
  skills: ["writer"], connectors: ["api"], ignored: [{ type: "agents", count: 2 }],
  notes: ["api: needs an access key"], displayName: "Fx", version: "1.0.0",
  commit: { sha: "c".repeat(40), date: "2026-01-01T00:00:00.000Z", message: "pin" },
};

describe("readStoredManifest", () => {
  it("reads a legacy row, which is detected by the ABSENCE of schemaVersion", () => {
    // The column is jsonb typed Record<string, unknown>, so a shape change is invisible
    // to the compiler: without this reader, service.ts would have kept reading
    // displayName and notes from the top level and rendered blanks for every upgraded
    // plugin, with nothing failing at build time to say so.
    const r = readStoredManifest(legacy);
    expect(r.inventory).toEqual(legacy);
    expect(r.installSurface).toBeNull();
    expect(r.committedRevision).toBe(0);
    expect(r.applyState).toBeNull();
  });

  it("reads a V2 row from under `inventory`", () => {
    const r = readStoredManifest(writeStoredManifest({ inventory: legacy, installSurface: surface, committedRevision: 7 }));
    expect(r.inventory).toEqual(legacy);
    expect(r.installSurface).toEqual(surface);
    expect(r.committedRevision).toBe(7);
  });

  it("gives a legacy row revision 0, the value a first claim expects", () => {
    // A legacy row has never been claimed, so its counter has to read as "never".
    expect(readStoredManifest(legacy).committedRevision).toBe(0);
    expect(readStoredManifest(null).committedRevision).toBe(0);
    expect(readStoredManifest(undefined).committedRevision).toBe(0);
  });

  it("does NOT give a malformed V2 row revision 0", () => {
    // 0 is what a first claim matches, so reading a corrupt counter as 0 would let a
    // stale apply win the CAS. It has to be a value no claim can match instead.
    const r = readStoredManifest({ schemaVersion: 2, inventory: legacy, installSurface: surface });
    expect(r.committedRevision).toBeNaN();
    expect(r.committedRevision === 0).toBe(false);
  });

  it("survives a row that is not an object at all", () => {
    // The plugins list reads through here too, so a corrupt row must not take the whole
    // page down — the install simply has no baseline.
    for (const junk of ["", 0, false, [], "a string"]) {
      const r = readStoredManifest(junk);
      expect(r.installSurface).toBeNull();
    }
  });

  it("returns an empty inventory rather than undefined fields", () => {
    const r = readStoredManifest({ schemaVersion: 2, committedRevision: 1 });
    expect(r.inventory).toEqual({ skills: [], connectors: [], ignored: [], notes: [] });
  });
});

describe("writeStoredManifest", () => {
  it("refuses a non-finite revision instead of serializing it to null", () => {
    // JSON turns NaN into null, so writing back a fail-closed read would produce a row
    // that no claim can ever match, with nothing recording how it got that way.
    expect(() => writeStoredManifest({ inventory: legacy, installSurface: surface, committedRevision: Number.NaN }))
      .toThrow(/non-finite committedRevision/);
  });

  it("round-trips through JSON, which is how the column actually stores it", () => {
    const written = writeStoredManifest({ inventory: legacy, installSurface: surface, committedRevision: 3 });
    const r = readStoredManifest(JSON.parse(JSON.stringify(written)));
    expect(r).toEqual({ inventory: legacy, installSurface: surface, committedRevision: 3, applyState: null });
  });
});
