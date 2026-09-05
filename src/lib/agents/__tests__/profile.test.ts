import { describe, it, expect } from "vitest";
import {
  ASSISTANT_PROFILE,
  RAW_PROFILE,
  CAPABILITY_GROUPS,
  BACKGROUND_PASSES,
  agentProfileSchema,
  capProfile,
  parseAgentProfile,
  presetOf,
  profilesEqual,
  resolveAgentProfile,
  type AgentProfile,
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

describe("resolveAgentProfile — org ceiling", () => {
  /** A permissive ceiling with specific things forbidden. */
  const ceiling = (over: {
    capabilities?: Partial<AgentProfile["capabilities"]>;
    persona?: AgentProfile["persona"];
    sessionContext?: boolean;
  }): AgentProfile =>
    agentProfileSchema.parse({
      ...ASSISTANT_PROFILE,
      ...over,
      capabilities: { ...ASSISTANT_PROFILE.capabilities, ...over.capabilities },
    });

  it("passes a project through untouched under a fully permissive ceiling", () => {
    // The built-in default IS the maximum, which is why a pure ceiling still gives
    // an admin complete global control: there's nothing above "everything on".
    expect(resolveAgentProfile(null, ASSISTANT_PROFILE)).toEqual(ASSISTANT_PROFILE);
    expect(resolveAgentProfile(RAW_PROFILE, ASSISTANT_PROFILE)).toEqual(RAW_PROFILE);
  });

  it("clamps a project that asks for more than the ceiling allows", () => {
    const resolved = resolveAgentProfile(ASSISTANT_PROFILE, ceiling({ capabilities: { memory: false } }));
    expect(resolved.capabilities.memory).toBe(false);
    // …and touches nothing else. A ceiling that leaked into other fields would
    // silently reshape every project on the instance.
    for (const g of CAPABILITY_GROUPS.filter((x) => x !== "memory")) {
      expect(resolved.capabilities[g]).toBe(true);
    }
    expect(resolved.persona).toBe("append");
    expect(resolved.sessionContext).toBe(true);
  });

  it("never GRANTS what a project turned off", () => {
    expect(resolveAgentProfile(RAW_PROFILE, ASSISTANT_PROFILE)).toEqual(RAW_PROFILE);
  });

  it("reaches chats with no project at all", () => {
    // `null` is a project-less chat — the only lever an admin has over those.
    const resolved = resolveAgentProfile(null, RAW_PROFILE);
    expect(resolved).toEqual(RAW_PROFILE);
  });

  it("treats replace and no-session-context as the restrictive side", () => {
    // "More restrictive" has to be well defined for the non-boolean fields too,
    // or the fold couldn't cover them uniformly.
    const p = resolveAgentProfile(ASSISTANT_PROFILE, ceiling({ persona: "replace", sessionContext: false }));
    expect(p.persona).toBe("replace");
    expect(p.sessionContext).toBe(false);
    // And a project asking for `replace` is not dragged back to `append`.
    expect(resolveAgentProfile({ persona: "replace" }, ASSISTANT_PROFILE).persona).toBe("replace");
  });

  it("folds in any order (the ceiling is a commutative min)", () => {
    const a = ceiling({ capabilities: { sandbox: false }, sessionContext: false });
    const b = ceiling({ capabilities: { memory: false }, persona: "replace" });
    expect(capProfile(a, b)).toEqual(capProfile(b, a));
    // Which is what makes adding a third layer (a user, a chat) one more call.
    expect(capProfile(capProfile(a, b), ASSISTANT_PROFILE)).toEqual(capProfile(a, b));
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

describe("background passes", () => {
  // The `.prefault` regression, on the second nested object that can suffer it: a
  // `.default({})` here would read every pass as undefined — falsy — and silently
  // turn off titles, memory extraction and compaction on every project at once.
  it("defaults every pass on when nothing is stored", () => {
    for (const k of BACKGROUND_PASSES) {
      expect(ASSISTANT_PROFILE.background[k], `pass ${k} must default to enabled`).toBe(true);
    }
  });

  it("fills in only the passes a partial row is missing", () => {
    const p = parseAgentProfile({ background: { factExtraction: false } });
    expect(p.background.factExtraction).toBe(false);
    expect(p.background.autoTitle).toBe(true);
    expect(p.background.compaction).toBe(true);
  });

  it("makes a raw run do no background work at all", () => {
    for (const k of BACKGROUND_PASSES) expect(RAW_PROFILE.background[k]).toBe(false);
  });

  it("lets the ceiling forbid a pass but never impose one", () => {
    const ceiling = agentProfileSchema.parse({ background: { factExtraction: false } });
    const project = agentProfileSchema.parse({ background: { autoTitle: false } });

    const resolved = resolveAgentProfile(project, ceiling);
    expect(resolved.background.factExtraction).toBe(false); // the ceiling's veto
    expect(resolved.background.autoTitle).toBe(false); // the project's own choice
    expect(resolved.background.compaction).toBe(true);

    // And the fold stays commutative, like every other field.
    expect(capProfile(project, ceiling)).toEqual(capProfile(ceiling, project));
  });

  it("counts a changed pass as a custom profile, not the assistant preset", () => {
    const p = parseAgentProfile({ background: { factExtraction: false } });
    expect(profilesEqual(p, ASSISTANT_PROFILE)).toBe(false);
    expect(presetOf(p)).toBe("custom");
  });
});

describe("three layers: user, org, project", () => {
  const full = (over: Partial<AgentProfile["capabilities"]>): AgentProfile =>
    agentProfileSchema.parse({ capabilities: over });

  it("lets a user switch their own memory off even though the org allows it", () => {
    const resolved = resolveAgentProfile(null, capProfile(full({ memory: false }), ASSISTANT_PROFILE));
    expect(resolved.capabilities.memory).toBe(false);
    // Nothing else moves — one user's preference is not a policy change.
    expect(resolved.capabilities.sandbox).toBe(true);
    expect(resolved.capabilities.connectors).toBe(true);
  });

  it("does not let a user hand themselves back what the admin turned off", () => {
    // The whole point of folding by minimum: the user layer is a request to
    // restrict, never a grant. A UI bug or a hand-crafted PUT can't widen access.
    const org = full({ sandbox: false });
    const user = agentProfileSchema.parse({});
    expect(resolveAgentProfile(null, capProfile(user, org)).capabilities.sandbox).toBe(false);
  });

  it("gives the same answer whichever order the layers fold in", () => {
    // Order-independence is what makes adding a fourth layer a one-line change
    // rather than a decision about precedence.
    const user = full({ memory: false });
    const org = full({ sandbox: false });
    const project = { capabilities: { connectors: false } };
    expect(resolveAgentProfile(project, capProfile(user, org))).toEqual(
      resolveAgentProfile(project, capProfile(org, user)),
    );
  });
});
