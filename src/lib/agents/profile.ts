import { z } from "zod";

/**
 * What a project lets its agent BE — the capability allow-list plus how the
 * system prompt is composed around the project's own instructions.
 *
 * The load-bearing idea: a capability group owns BOTH its tools and the prompt
 * block(s) that teach the model to drive them. Tools are assembled in
 * `prepareRun` and their protocol text in `buildSystemPrompt` — two different
 * files — so without this coupling a naive "clear the system prompt" switch
 * leaves the model holding tools it no longer knows how to use, or reading
 * instructions for tools it doesn't have. Gating both sides off the same group
 * makes that incoherent state unrepresentable rather than merely discouraged.
 *
 * Turning everything off is the raw-prompt mode: no tools at all, and a system
 * prompt that is exactly the project's instructions — or no system message
 * whatsoever when those are empty. That's safe to offer because SYSTEM_PROMPT
 * (see chat-agent.ts) carries only persona, style, and working habits; there is
 * no safety or policy text in it that replacing would strip.
 */
export const CAPABILITY_GROUPS = ["sandbox", "connectors", "skills", "manage", "memory"] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

/**
 * Every field carries a default, deliberately: `parseAgentProfile` on ANY stored
 * shape — null, `{}`, a row written before a group existed, or one from a newer
 * version carrying keys this build doesn't know — yields a COMPLETE profile. That
 * is what keeps consuming code free of `?? true` repeated at each call site, and
 * what lets a new group ship without a migration.
 */
export const agentProfileSchema = z.object({
  capabilities: z
    .object({
      /** `execute_bash` + the file tools + `view_file`; the sandbox contract, the
       *  workspace snapshot, and the attached/synced folder blocks. Off means the
       *  session never creates a container at all (`ensureSession` is never
       *  reached). */
      sandbox: z.boolean().default(true),
      /** MCP connector tools + `find_tool` + provider-executed tools (e.g.
       *  Gemini's Google Search grounding); the deferred-connector index.
       *  Provider-native tools ride here because from the model's side they are the
       *  same act: reach outside Capka for data. Off means `loadMcpTools` is never
       *  called, so no stdio connector child process is spawned either. */
      connectors: z.boolean().default(true),
      /** The `skill` tool + the available-skills index. */
      skills: z.boolean().default(true),
      /** The `manage` control plane + `ask` + the first-run concierge nudge. `ask`
       *  rides along because it is the same machinery — the agent coordinating with
       *  the human mid-turn; without it the model simply asks in prose. */
      manage: z.boolean().default(true),
      /** Long-term memory, ALL of it: the two "what you remember" prompt blocks,
       *  the remember/forget tools, and the per-turn reconcile write (an extra LLM
       *  call, so this is the one group whose absence is also cheaper). Off means a
       *  run neither reads nor writes any memory doc. Existing docs are left
       *  untouched — merely unused — so turning it back on restores them. */
      memory: z.boolean().default(true),
    })
    // `.prefault`, NOT `.default`: Zod 4's `.default(v)` short-circuits and returns
    // v verbatim without running it through the schema, so `.default({})` would
    // yield a literally empty capabilities object — every group silently off, on
    // every project, with a green typecheck (`.default` is typed against the INPUT
    // type, where `{}` is valid). `.prefault` feeds the value through the schema so
    // the field defaults below actually apply.
    .prefault({}),
  /** How the project's instructions relate to Capka's base persona. "append"
   *  (today's behaviour) puts them under the persona as a `--- Project
   *  Instructions ---` section. "replace" drops the persona AND that header: the
   *  instructions are the system prompt, verbatim. The header matters — framing
   *  the text as "here are some instructions" gives the model a different posture
   *  than "you are X", which is the whole point of replacing. */
  persona: z.enum(["append", "replace"]).default("append"),
  /** The "who you're talking to" system message (name, conversation date, tz).
   *  Off gives the model no identity and no date — correct for raw prompting,
   *  where the operator supplies whatever context they want in the text itself. */
  sessionContext: z.boolean().default(true),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** Capka's normal behaviour, and what a project with no stored profile gets. */
export const ASSISTANT_PROFILE: AgentProfile = agentProfileSchema.parse({});

/** Nothing between the operator and the model. */
export const RAW_PROFILE: AgentProfile = agentProfileSchema.parse({
  capabilities: { sandbox: false, connectors: false, skills: false, manage: false, memory: false },
  persona: "replace",
  sessionContext: false,
});

/** Parse whatever sits in the jsonb column. Never throws: a corrupt or
 *  unrecognizable shape degrades to the assistant default rather than failing a
 *  run — a bad profile row must not cost the user their reply. */
export function parseAgentProfile(stored: unknown): AgentProfile {
  const parsed = agentProfileSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : ASSISTANT_PROFILE;
}

/**
 * Take the more RESTRICTIVE of two profiles, field by field.
 *
 * "More restrictive" is well defined for every field, which is what lets one fold
 * cover all of them: a capability is on only if both say on; `replace` is more
 * minimal than `append` (it strips the built-in persona); no session context is
 * more minimal than some. Associative and commutative, so layers can be folded in
 * any order and a third layer is one more `cap()` call.
 */
export function capProfile(a: AgentProfile, b: AgentProfile): AgentProfile {
  return {
    capabilities: Object.fromEntries(
      CAPABILITY_GROUPS.map((g) => [g, a.capabilities[g] && b.capabilities[g]]),
    ) as AgentProfile["capabilities"],
    persona: a.persona === "replace" || b.persona === "replace" ? "replace" : "append",
    sessionContext: a.sessionContext && b.sessionContext,
  };
}

/**
 * The profile a run actually uses: the project's, clamped by the org ceiling.
 *
 * The org layer is a CEILING, never a default — and that is sufficient for
 * complete global control precisely because the built-in default
 * (ASSISTANT_PROFILE) is already maximal: there is nothing above "everything on"
 * left to grant. One semantic instead of two, so nobody has to remember whether a
 * given org knob sets a baseline or an upper bound.
 *
 * It also reaches chats with no project at all — they resolve `null` to the
 * assistant default and then get clamped, which is the only way an admin can make
 * project-less chats raw.
 */
export function resolveAgentProfile(project: unknown, org: AgentProfile): AgentProfile {
  return capProfile(parseAgentProfile(project), org);
}

export type AgentPreset = "assistant" | "raw" | "custom";

/** Field-by-field equality — not `JSON.stringify`, so key order can never make two
 *  equal profiles compare different (the settings form builds profiles by spreading
 *  and toggling, which offers no order guarantee). */
export function profilesEqual(a: AgentProfile, b: AgentProfile): boolean {
  return (
    a.persona === b.persona &&
    a.sessionContext === b.sessionContext &&
    CAPABILITY_GROUPS.every((g) => a.capabilities[g] === b.capabilities[g])
  );
}

/** Which preset a profile corresponds to. DERIVED, never stored — one source of
 *  truth, so a saved preset label can never disagree with the profile it names. */
export function presetOf(p: AgentProfile): AgentPreset {
  if (profilesEqual(p, ASSISTANT_PROFILE)) return "assistant";
  if (profilesEqual(p, RAW_PROFILE)) return "raw";
  return "custom";
}
