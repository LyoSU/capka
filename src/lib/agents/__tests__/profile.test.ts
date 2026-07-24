import { describe, it, expect } from "vitest";
import {
  ASSISTANT_PROFILE,
  RAW_PROFILE,
  CAPABILITY_GROUPS,
  agentProfileSchema,
  parseAgentProfile,
  presetOf,
  profilesEqual,
  resolveAgentProfile,
} from "../profile";

describe("agent profile defaults", () => {
  // THE regression to guard forever: Zod 4's `.default(v)` returns v verbatim
  // without running it through the schema, so `z.object({…}).default({})` yields a
  // literally empty object and every capability reads as `undefined` — falsy, so
  // every group silently off on every project, with a green typecheck (`.default`
  // is typed against the INPUT type, where `{}` is valid). `.prefault` is what
  // actually applies the field defaults. This test is the only thing that catches
  // a revert to `.default`.
  it("fills EVERY capability group when nothing is stored", () => {
    for (const g of CAPABILITY_GROUPS) {
      expect(ASSISTANT_PROFILE.capabilities[g], `group ${g} must default to enabled`).toBe(true);
    }
    expect(ASSISTANT_PROFILE.persona).toBe("append");
    expect(ASSISTANT_PROFILE.sessionContext).toBe(true);
  });

  it("treats null, an empty object, and an empty capabilities map as the assistant default", () => {
    for (const stored of [null, undefined, {}, { capabilities: {} }]) {
      expect(parseAgentProfile(stored)).toEqual(ASSISTANT_PROFILE);
    }
  });

  it("fills in only the groups a partial row is missing", () => {
    // A row written before a group existed, or by a UI that only sent what changed.
    const p = parseAgentProfile({ capabilities: { memory: false }, persona: "replace" });
    expect(p.capabilities.memory).toBe(false);
    expect(p.capabilities.sandbox).toBe(true);
    expect(p.persona).toBe("replace");
    expect(p.sessionContext).toBe(true);
  });

  it("ignores keys it doesn't know, so a row from a newer build still parses", () => {
    const p = parseAgentProfile({ capabilities: { sandbox: false, quantum: true }, futureKnob: 7 });
    expect(p.capabilities.sandbox).toBe(false);
    expect(p).not.toHaveProperty("futureKnob");
  });

  it("degrades a corrupt row to the assistant default instead of failing the run", () => {
    // A bad profile must never cost the user their reply.
    for (const junk of ["nonsense", 42, [], { capabilities: "yes" }, { persona: "shout" }]) {
      expect(parseAgentProfile(junk)).toEqual(ASSISTANT_PROFILE);
    }
  });
});

describe("resolveAgentProfile", () => {
  it("passes the project's profile through when the org allows memory", () => {
    expect(resolveAgentProfile(null, { memory: true })).toEqual(ASSISTANT_PROFILE);
    expect(resolveAgentProfile(RAW_PROFILE, { memory: true })).toEqual(RAW_PROFILE);
  });

  it("lets the org kill switch override a project that wants memory", () => {
    // A switch a project could re-enable would not be a kill switch.
    const resolved = resolveAgentProfile(ASSISTANT_PROFILE, { memory: false });
    expect(resolved.capabilities.memory).toBe(false);
    // …and only memory. The org layer must not quietly touch anything else.
    for (const g of CAPABILITY_GROUPS.filter((x) => x !== "memory")) {
      expect(resolved.capabilities[g]).toBe(true);
    }
    expect(resolved.persona).toBe("append");
  });

  it("never re-enables memory a project turned off", () => {
    expect(resolveAgentProfile(RAW_PROFILE, { memory: true }).capabilities.memory).toBe(false);
  });
});

describe("presets", () => {
  it("recognizes each preset, and labels anything else custom", () => {
    expect(presetOf(ASSISTANT_PROFILE)).toBe("assistant");
    expect(presetOf(RAW_PROFILE)).toBe("raw");
    expect(presetOf({ ...ASSISTANT_PROFILE, sessionContext: false })).toBe("custom");
    expect(presetOf({ ...RAW_PROFILE, capabilities: { ...RAW_PROFILE.capabilities, sandbox: true } })).toBe("custom");
  });

  it("compares by field, so key order can't make equal profiles differ", () => {
    // The settings form builds profiles by spreading and toggling — no order guarantee.
    const reordered = agentProfileSchema.parse({
      sessionContext: true,
      persona: "append",
      capabilities: { memory: true, manage: true, skills: true, connectors: true, sandbox: true },
    });
    expect(profilesEqual(reordered, ASSISTANT_PROFILE)).toBe(true);
    expect(presetOf(reordered)).toBe("assistant");
  });

  it("has a raw preset that really is empty — every group off, no persona, no session", () => {
    for (const g of CAPABILITY_GROUPS) expect(RAW_PROFILE.capabilities[g]).toBe(false);
    expect(RAW_PROFILE.persona).toBe("replace");
    expect(RAW_PROFILE.sessionContext).toBe(false);
  });
});
