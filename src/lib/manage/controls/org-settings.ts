import { z } from "zod";
import { getSetting, setSetting, getOrgAgentProfile, setOrgAgentProfile } from "@/lib/settings";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";
import { CAPABILITY_GROUPS, type CapabilityGroup } from "@/lib/agents/profile";
import type { Control, ManageContext } from "../types";

// English is the source of truth for control copy (see manage/i18n.ts), so these
// live here beside the controls rather than in a message catalog.
const AGENT_CEILING_TITLES: Record<CapabilityGroup, string> = {
  sandbox: "Agent: files and code",
  connectors: "Agent: connectors and web data",
  skills: "Agent: skills",
  manage: "Agent: managing settings from chat",
  memory: "Agent: long-term memory",
};
const AGENT_CEILING_DESCRIPTIONS: Record<CapabilityGroup, string> = {
  sandbox: "Whether the agent may open files and run code in its sandbox.",
  connectors: "Whether the agent may call MCP connectors and provider web-search tools.",
  skills: "Whether the agent may load skills.",
  manage: "Whether the agent may change settings and ask clarifying questions through the manage tool.",
  memory:
    "Whether the agent may remember durable facts about people and their projects between conversations. Off stops all memory reading AND writing; already-saved memories are kept, just unused, so turning it back on restores them.",
};

/** Build an org-wide setting control over the existing key/value settings store.
 *  Every org control is admin-only and confirm-risk by construction, so a
 *  platform-wide change can never be applied from chat without a preview + an
 *  explicit second confirmation. Strings are English (the source of truth +
 *  fallback); Ukrainian is layered on via i18n keyed by the control id. */
function orgSetting(o: {
  key: string;
  title: string;
  description: string;
  schema: z.ZodType<string>;
  def: string;
  format?: (v: string) => string;
  impact?: (ctx: ManageContext, next: string) => Promise<string | undefined>;
  alwaysConfirm?: boolean;
}): Control {
  return {
    id: `org.${o.key}`,
    title: o.title,
    description: o.description,
    scope: "org",
    requiredRole: "admin",
    risk: "confirm",
    schema: o.schema,
    read: async () => (await getSetting(o.key)) ?? o.def,
    apply: async (_ctx, v) => {
      await setSetting(o.key, v);
    },
    format: o.format,
    impact: o.impact,
    alwaysConfirm: o.alwaysConfirm,
  };
}

const bool = z.enum(["true", "false"]);
const boolFmt = (v: string) => (v === "true" ? "Enabled" : "Disabled");
const int = z.string().regex(/^\d+$/, "Must be a whole number.");
// A whole number with a sane ceiling. Without it, a fat-fingered
// "999999999999999" for model_min_context would silently hide EVERY model, or a
// huge max_context_tokens would demand an impossible window — a confusing dead
// end for a non-technical admin. 10M tokens is far above any real model.
const boundedInt = (max: number) =>
  int.refine((v) => Number(v) <= max, `Must be at most ${max.toLocaleString("en-US")}.`);
const TOKENS_CEILING = 10_000_000;

/**
 * The org agent ceiling, exposed to chat one bit at a time.
 *
 * These do NOT get their own settings keys: each projects into and out of the
 * single `agent_profile` object (see getOrgAgentProfile), so a change made in chat
 * and one made on the Security page are the same write. A key per bit would be the
 * obvious shape and the wrong one — two stores for one fact drift, which is exactly
 * how `sandbox_enabled` ended up a switch that saved and did nothing.
 *
 * Admin-only and confirm-risk like every org control, so clamping the whole
 * instance always shows a preview first.
 */
const agentCeilingControls: Control[] = [
  ...CAPABILITY_GROUPS.map((group) => ({
    id: `org.agent_${group}`,
    title: AGENT_CEILING_TITLES[group],
    description: `${AGENT_CEILING_DESCRIPTIONS[group]} This is an instance-wide ceiling: switching it off removes the capability from every chat, whatever an individual project is set to.`,
    scope: "org" as const,
    requiredRole: "admin" as const,
    risk: "confirm" as const,
    schema: bool,
    format: boolFmt,
    read: async () => String((await getOrgAgentProfile()).capabilities[group]),
    apply: async (_ctx: ManageContext, v: string) => {
      const current = await getOrgAgentProfile();
      await setOrgAgentProfile({ ...current, capabilities: { ...current.capabilities, [group]: v === "true" } });
    },
  })),
  {
    id: "org.agent_persona",
    title: "Built-in persona",
    description:
      'Whether the agent keeps Capka\'s built-in persona and working style. Off ("replace") makes a project\'s own instructions the ENTIRE system prompt, instance-wide: a chat with no project instructions then gets no system prompt at all.',
    scope: "org",
    requiredRole: "admin",
    risk: "confirm",
    schema: bool,
    format: boolFmt,
    read: async () => String((await getOrgAgentProfile()).persona === "append"),
    apply: async (_ctx, v) => {
      const current = await getOrgAgentProfile();
      await setOrgAgentProfile({ ...current, persona: v === "true" ? "append" : "replace" });
    },
  },
  {
    id: "org.agent_session_context",
    title: "Tell the agent who and when",
    description:
      "Whether each conversation tells the agent the user's name, the conversation's date, and their language. Off removes that instance-wide, so the agent has no idea what today is unless someone says so.",
    scope: "org",
    requiredRole: "admin",
    risk: "confirm",
    schema: bool,
    format: boolFmt,
    read: async () => String((await getOrgAgentProfile()).sessionContext),
    apply: async (_ctx, v) => {
      const current = await getOrgAgentProfile();
      await setOrgAgentProfile({ ...current, sessionContext: v === "true" });
    },
  },
];

export const orgControls: Control[] = [
  orgSetting({
    key: "agent_autonomy",
    title: "Agent autonomy",
    description:
      'How the agent applies changes from chat: "supervised" (the user approves each risky change on a confirmation card) or "autonomous" (the agent applies personal changes directly, conversationally). Even autonomous still asks before changing a platform-wide setting (one that affects every user) or installing a connector that runs third-party code.',
    schema: z.enum(["supervised", "autonomous"]),
    def: "supervised",
    format: (v) => (v === "autonomous" ? "Autonomous" : "Supervised"),
    // Flipping the master switch always gets a confirmation, even from autonomous,
    // so a prompt-injected agent can't quietly disable its own supervision. (Being
    // org-scoped now also guarantees this, but the flag documents the intent.)
    alwaysConfirm: true,
    impact: async (_ctx, next) =>
      next === "autonomous"
        ? "The agent will apply personal preferences and install skills directly, without asking each time. Platform-wide settings and connectors that run third-party code still require your confirmation. Undo and the audit log still apply."
        : undefined,
  }),
  orgSetting({
    key: "platform_name",
    title: "Platform name",
    description: "The installation name shown in the browser tab, the sidebar header, and the sign-in page.",
    schema: z.string().min(1, "Name can't be empty.").max(60, "Name too long (max 60)."),
    def: "Capka",
  }),
  // NOTE: no `sandbox_enabled` control any more. That key was never read outside
  // the settings UI, so setting it from chat reported success and changed nothing;
  // `org.agent_sandbox` (in agentCeilingControls) is the enforced replacement.
  orgSetting({
    key: "sandbox_network",
    title: "Sandbox network",
    description: 'Sandbox network access: "none" (isolated) or "bridge" (outbound network).',
    schema: z.enum(["none", "bridge"]),
    def: "none",
    format: (v) => (v === "bridge" ? "Network access" : "Isolated (no network)"),
    impact: async (_ctx, next) =>
      next === "bridge"
        ? "Sandboxes gain outbound network access — and only if SANDBOX_ALLOW_NETWORK=true is set on the server."
        : undefined,
  }),
  orgSetting({
    key: "block_private_provider_urls",
    title: "Block private provider URLs",
    description: "SSRF protection: reject provider base URLs pointing at a private network.",
    schema: bool,
    def: "true",
    format: boolFmt,
    impact: async (_ctx, next) =>
      next === "false" ? "Turning this off weakens SSRF protection — only do so deliberately." : undefined,
  }),
  orgSetting({
    key: "share_admin_providers",
    title: "Shared provider key",
    description: "Whether regular users run on the shared provider key the admin connected.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "members_can_install_plugins",
    title: "Members can install plugins",
    description: "Allow regular users to install plugins/skills/connectors themselves.",
    schema: bool,
    def: "false",
    format: boolFmt,
  }),
  orgSetting({
    key: "update_check_enabled",
    title: "Update checks",
    description: "Periodically check for new Capka versions.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "model_min_context",
    title: "Minimum model context",
    description: "Hide models whose context window is smaller than this (in tokens).",
    schema: boundedInt(TOKENS_CEILING),
    def: String(DEFAULT_MODEL_MIN_CONTEXT),
    format: (v) => `${v} tokens`,
  }),
  orgSetting({
    key: "max_context_tokens",
    title: "Context limit",
    description: 'Upper bound on context tokens per turn ("0" = auto, per model).',
    schema: boundedInt(TOKENS_CEILING),
    def: "0",
    format: (v) => (v === "0" ? "auto (per model)" : `${v} tokens`),
  }),
  orgSetting({
    key: "model_max_price",
    title: "Maximum model price",
    description: 'Hide models more expensive than this (per 1M tokens; "0" = no limit).',
    schema: z.string().regex(/^\d+(\.\d+)?$/, "Must be a number.").refine((v) => Number(v) <= 100_000, "Price is unreasonably high (max 100000)."),
    def: "0",
    format: (v) => (v === "0" ? "no limit" : `$${v}`),
  }),
  orgSetting({
    key: "host_folder_access",
    title: "Server folder access",
    description:
      "Whether administrators may bind-mount a folder from the SERVER (a directory on the machine running Capka) into a chat's sandbox at /folders/<name>. Admin-only and read-only by default. Off by default.",
    schema: bool,
    def: "false",
    format: boolFmt,
  }),
  orgSetting({
    key: "pc_folder_access",
    title: "Personal folder access",
    description:
      'Whether users may connect a folder from their OWN computer (synced into the chat workspace via the browser): "off" (no one), "admins" (only administrators), or "everyone" (any user).',
    schema: z.enum(["off", "admins", "everyone"]),
    def: "off",
    format: (v) => ({ off: "Off", admins: "Admins only", everyone: "Everyone" })[v] ?? v,
  }),
  ...agentCeilingControls,
  orgSetting({
    key: "automations_enabled",
    title: "Automations",
    description: "Whether users may create scheduled automations (recurring agent runs).",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
  orgSetting({
    key: "automations_per_user",
    title: "Automations per user",
    description: "How many active automations one user may have.",
    schema: boundedInt(100),
    def: "10",
  }),
  orgSetting({
    key: "automations_min_interval_minutes",
    title: "Minimum automation interval",
    description: "The shortest allowed gap between two runs of one automation, in minutes. Protects the budget from accidental 'every minute' schedules.",
    schema: boundedInt(7 * 24 * 60),
    def: "60",
    format: (v) => `${v} min`,
  }),
];
