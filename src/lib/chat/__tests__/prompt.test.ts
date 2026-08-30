import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../prompt";
import { SYSTEM_PROMPT, buildSandboxPrompt } from "@/lib/agents/chat-agent";
import { ASSISTANT_PROFILE, RAW_PROFILE, type AgentProfile } from "@/lib/agents/profile";

/** A profile with one capability group flipped off, everything else default. */
const without = (group: keyof AgentProfile["capabilities"]): AgentProfile => ({
  ...ASSISTANT_PROFILE,
  capabilities: { ...ASSISTANT_PROFILE.capabilities, [group]: false },
});

/** Everything a fully-loaded turn feeds the prompt, so a gate that removes too
 *  much (or too little) shows up as a change in an unrelated block. */
const FULL: Parameters<typeof buildSystemPrompt>[0] = {
  project: { systemPrompt: "Be terse." },
  skills: [{ name: "pdf", description: "PDF things", body: "steps" }],
  connectorIndex: "## Available connectors\n- github",
  memoryManifest: "## User memory\n\nRecent facts:\n- «likes tea»\n\n## Project memory\n\nRecent facts:\n- «ships on Fridays»",
  workspaceSnapshot: "report.docx",
  user: { name: "Yura", timezone: "Europe/Kyiv" },
  attachedFolders: [{ name: "reports", readOnly: true }],
  syncedFolders: [{ name: "desktop" }],
  conversationStartedAt: new Date("2026-07-24T10:00:00Z"),
  concierge: true,
  networkMode: "bridge",
};

describe("buildSystemPrompt — concierge", () => {
  it("adds the one-time first-run concierge nudge only when concierge is set, and keeps it out of the cached prefix", () => {
    const withNudge = buildSystemPrompt({ concierge: true });
    const without = buildSystemPrompt({ concierge: false });

    // The nudge lives in the volatile tier (fires once — must not pollute the
    // cache-stable prefix that every other turn reuses).
    expect(withNudge.volatile).toContain("First run");
    expect(withNudge.volatile.toLowerCase()).toContain("manage");
    expect(withNudge.stable).not.toContain("First run");

    // Off by default — an ordinary turn never sees it.
    expect(without.volatile).not.toContain("First run");
  });
});

describe("buildSystemPrompt — network state", () => {
  it("tells the model it has network when egress is bridged", () => {
    const p = buildSystemPrompt({ networkMode: "bridge" });
    expect(p.stable).toContain("outbound network access");
    expect(p.stable).not.toContain("no network access");
  });

  it("tells the model there is no network when egress is cut, and defaults to no network when unspecified", () => {
    const off = buildSystemPrompt({ networkMode: "none" });
    expect(off.stable).toContain("no network access");
    expect(off.stable).not.toContain("outbound network access");

    // Safe default: absent an explicit mode, assume no egress.
    expect(buildSystemPrompt({}).stable).toContain("no network access");
  });
});

describe("buildSystemPrompt — tier assembly", () => {
  // The regression this pins: `prompt.stable` carries the first Anthropic cache
  // breakpoint, so ANY change to layer order or the separator between layers
  // invalidates the cached prefix for every existing user exactly once. Asserting
  // the literal composition (not just "contains X") is what makes that impossible
  // to do by accident.
  it("joins the stable layers in a fixed order with a blank line between them", () => {
    const p = buildSystemPrompt({
      project: { systemPrompt: "Be terse." },
      skills: [{ name: "pdf", description: "PDF things", body: "steps" }],
      connectorIndex: "## Available connectors\n- github",
      networkMode: "none",
    });

    // The first two layers, verbatim and blank-line separated.
    expect(p.stable.startsWith(`${SYSTEM_PROMPT}\n\n${buildSandboxPrompt("none")}`)).toBe(true);
    // The rest follow in declaration order, each separated by exactly one blank line.
    const order = ["--- Project Instructions ---", "pdf", "Available connectors", "Managing settings & configuration"];
    const positions = order.map((needle) => p.stable.indexOf(needle));
    expect(positions.every((i) => i > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(p.stable).not.toMatch(/\n{3}/); // never a double blank line between layers
  });

  it("drops a tier entirely rather than emitting an empty one", () => {
    // An empty `stable` must be FALSY, not "": the runner keys "push a system
    // message" off it, and Anthropic rejects a message with an empty text block.
    const bare = buildSystemPrompt({ profile: RAW_PROFILE });
    expect(bare.stable).toBe("");
    expect(bare.session).toBe("");
    expect(bare.volatile).toBe("");
  });
});

describe("buildSystemPrompt — capability gating", () => {
  it("gives the raw profile nothing but the project's own instructions", () => {
    const p = buildSystemPrompt({ ...FULL, profile: RAW_PROFILE });

    // Verbatim — and specifically WITHOUT the "--- Project Instructions ---"
    // header: in replace mode this text IS the persona, and framing it as a
    // labelled section puts the model in a different posture.
    expect(p.stable).toBe("Be terse.");
    expect(p.stable).not.toContain("Project Instructions");
    expect(p.session).toBe("");
    expect(p.volatile).toBe("");
  });

  it("keeps the base persona in append mode and adds the project's section under it", () => {
    const p = buildSystemPrompt({ ...FULL, profile: ASSISTANT_PROFILE });
    expect(p.stable).toContain(SYSTEM_PROMPT);
    expect(p.stable).toContain("--- Project Instructions ---\nBe terse.");
  });

  it("removes only the sandbox group's own blocks when it is off", () => {
    const p = buildSystemPrompt({ ...FULL, profile: without("sandbox") });

    // Its protocol AND everything that only makes sense with file tools.
    expect(p.stable).not.toContain("/workspace");
    expect(p.volatile).not.toContain("Current workspace files");
    expect(p.volatile).not.toContain("Attached server folders");
    expect(p.volatile).not.toContain("Folders synced");
    // Untouched neighbours — proof the gate isn't over-reaching.
    expect(p.stable).toContain(SYSTEM_PROMPT);
    expect(p.stable).toContain("Managing settings & configuration");
    expect(p.volatile).toContain("likes tea");
  });

  it("removes the whole memory manifest, and nothing else, when memory is off", () => {
    const p = buildSystemPrompt({ ...FULL, profile: without("memory") });
    // Both scopes go together: they arrive as one manifest, so there is no longer a
    // way for one to survive the gate without the other.
    expect(p.volatile).not.toContain("User memory");
    expect(p.volatile).not.toContain("Project memory");
    expect(p.volatile).not.toContain("likes tea");
    expect(p.volatile).not.toContain("ships on Fridays");
    expect(p.volatile).toContain("Current workspace files");
  });

  it("removes the skills index, the connector index, and the manage protocol with their groups", () => {
    expect(buildSystemPrompt({ ...FULL, profile: without("skills") }).stable).not.toContain("PDF things");
    expect(buildSystemPrompt({ ...FULL, profile: without("connectors") }).stable).not.toContain("Available connectors");

    const noManage = buildSystemPrompt({ ...FULL, profile: without("manage") });
    expect(noManage.stable).not.toContain("Managing settings & configuration");
    // The concierge nudge exists purely to offer configuration through `manage`,
    // so it goes with that group rather than lingering as a dead instruction.
    expect(noManage.volatile).not.toContain("First run");
  });

  it("drops the session tier on request without touching the other two", () => {
    const p = buildSystemPrompt({ ...FULL, profile: { ...ASSISTANT_PROFILE, sessionContext: false } });
    expect(p.session).toBe("");
    expect(p.stable).toContain(SYSTEM_PROMPT);
    expect(p.volatile).toContain("likes tea");
  });
});

describe("buildSystemPrompt — org instructions", () => {
  it("changes nothing at all when there are none", () => {
    // `prompt.stable` carries Anthropic's first cache breakpoint, so an unused
    // feature that shifts the prefix by one byte would invalidate every existing
    // user's cached prompt once. Absent, empty and whitespace must all be inert.
    const base = buildSystemPrompt(FULL);
    for (const value of [undefined, "", "   \n  "]) {
      expect(buildSystemPrompt({ ...FULL, orgInstructions: value })).toEqual(base);
    }
  });

  it("sits directly under the base persona, above the tool protocol", () => {
    // Position is the point: it answers "who are you", so it belongs in the persona
    // slot rather than after the sandbox contract.
    const p = buildSystemPrompt({ ...FULL, orgInstructions: "We are Acme." });
    expect(p.stable.startsWith(`${SYSTEM_PROMPT}\n\n--- Organization Instructions ---\nWe are Acme.\n\n${buildSandboxPrompt("bridge")}`)).toBe(true);
  });

  it("becomes the whole persona under a raw profile", () => {
    const p = buildSystemPrompt({ project: null, profile: RAW_PROFILE, orgInstructions: "You are a translator." });
    expect(p.stable).toBe("You are a translator.");
    expect(p.stable).not.toContain(SYSTEM_PROMPT);
  });

  it("keeps a project's instructions labelled when org instructions also exist", () => {
    // Two unlabelled blocks glued together read as one contradictory voice; the
    // label restores "general rule, then local refinement".
    const p = buildSystemPrompt({
      project: { systemPrompt: "Be terse." },
      profile: RAW_PROFILE,
      orgInstructions: "You are a translator.",
    });
    expect(p.stable).toBe("You are a translator.\n\n--- Project Instructions ---\nBe terse.");
  });

  it("still gives a project's instructions the persona slot when there are no org ones", () => {
    // The pre-existing raw-mode contract, unchanged.
    const p = buildSystemPrompt({ project: { systemPrompt: "Be terse." }, profile: RAW_PROFILE });
    expect(p.stable).toBe("Be terse.");
  });
});
