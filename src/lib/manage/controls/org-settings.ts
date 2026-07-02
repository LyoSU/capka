import { z } from "zod";
import { getSetting, setSetting } from "@/lib/settings";
import { DEFAULT_MODEL_MIN_CONTEXT } from "@/lib/constants";
import type { Control, ManageContext } from "../types";

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

export const orgControls: Control[] = [
  orgSetting({
    key: "agent_autonomy",
    title: "Agent autonomy",
    description:
      'How the agent applies changes from chat: "supervised" (the user approves each risky change on a confirmation card) or "autonomous" (the agent applies them directly, conversationally). Autonomous still asks before installing a connector that runs third-party code.',
    schema: z.enum(["supervised", "autonomous"]),
    def: "supervised",
    format: (v) => (v === "autonomous" ? "Autonomous" : "Supervised"),
    // Flipping the master switch always gets a confirmation, even from autonomous,
    // so a prompt-injected agent can't quietly disable its own supervision.
    alwaysConfirm: true,
    impact: async (_ctx, next) =>
      next === "autonomous"
        ? "The agent will change settings and install skills directly, without asking each time — only connectors that run third-party code still require confirmation. Undo and the audit log still apply."
        : undefined,
  }),
  orgSetting({
    key: "platform_name",
    title: "Platform name",
    description: "The installation name shown in the browser tab, the sidebar header, and the sign-in page.",
    schema: z.string().min(1, "Name can't be empty.").max(60, "Name too long (max 60)."),
    def: "Capka",
  }),
  orgSetting({
    key: "sandbox_enabled",
    title: "Sandbox execution",
    description: "Whether the agent may run code in its Docker sandbox.",
    schema: bool,
    def: "true",
    format: boolFmt,
  }),
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
];
