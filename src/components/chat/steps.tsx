import type { ComponentType } from "react";
import {
  FilePlus, FilePen, FileText, Folder, Search, Terminal, Code, Globe, Wrench,
  Sparkles, Plug,
} from "lucide-react";

export type StepIcon = ComponentType<{ className?: string }>;

/** A minimal translator shape (next-intl's `useTranslations("steps")`),
 *  decoupled so this module doesn't depend on next-intl's exact types. */
export type StepTranslator = (key: string, values?: Record<string, string | number>) => string;

/** What kind of action a step is, so the UI can group/colour by *intent*
 *  rather than by tool name. Non-technical users read intent, not tools. */
export type StepCategory = "file" | "exec" | "search" | "browse" | "mcp" | "skill" | "other";

/** A connected app behind an MCP tool — shown by brand, not a wrench. */
export interface StepBrand {
  /** Human label, e.g. "Notion", "Google Drive". */
  label: string;
  /** Single-letter mark for the chip. */
  letter: string;
  /** Brand colour for the chip; empty string = unknown connector (render Plug). */
  color: string;
}

export interface StepDescriptor {
  Icon: StepIcon;
  /** Past-tense, with the concrete object: "Created logo.svg". */
  label: string;
  /** Present-tense for the running state: "Creating logo.svg…". */
  activeLabel: string;
  /** Optional dim trailing detail (e.g. the command that ran). */
  detail?: string;
  /** Intent bucket — drives the rail icon and any per-category styling. */
  category: StepCategory;
  /** Present only for `mcp` steps — the connected app behind the tool. */
  brand?: StepBrand;
}

const basename = (p: unknown): string => {
  const s = typeof p === "string" ? p : "";
  const trimmed = s.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "file";
};

const clip = (s: unknown, n = 48): string => {
  const str = typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
  return str.length > n ? str.slice(0, n) + "…" : str;
};

/** snake_case / kebab → "Title Case" words. */
function titleCase(name: string): string {
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** snake_case / kebab tool name → "Title Case" words, for unknown/MCP tools. */
function prettyToolName(name: string): string {
  const words = name.replace(/^mcp[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Known MCP connectors → branded chip. Keyed by the *normalized* server token
 *  (lowercased, separators stripped) so "google_drive", "google-drive" and
 *  "googledrive" all resolve to the same brand. */
const BRANDS: Record<string, { label: string; color: string }> = {
  gmail: { label: "Gmail", color: "#ea4335" },
  googledrive: { label: "Google Drive", color: "#1a73e8" },
  gdrive: { label: "Google Drive", color: "#1a73e8" },
  drive: { label: "Google Drive", color: "#1a73e8" },
  googlecalendar: { label: "Google Calendar", color: "#4285f4" },
  gcal: { label: "Google Calendar", color: "#4285f4" },
  calendar: { label: "Calendar", color: "#4285f4" },
  notion: { label: "Notion", color: "#111111" },
  slack: { label: "Slack", color: "#4a154b" },
  github: { label: "GitHub", color: "#111111" },
  gitlab: { label: "GitLab", color: "#fc6d26" },
  linear: { label: "Linear", color: "#5e6ad2" },
  asana: { label: "Asana", color: "#f06a6a" },
  atlassian: { label: "Atlassian", color: "#0052cc" },
  jira: { label: "Jira", color: "#0052cc" },
  confluence: { label: "Confluence", color: "#0052cc" },
  hubspot: { label: "HubSpot", color: "#ff7a59" },
  intercom: { label: "Intercom", color: "#1f8ded" },
  todoist: { label: "Todoist", color: "#e44332" },
  figma: { label: "Figma", color: "#f24e1e" },
  canva: { label: "Canva", color: "#00c4cc" },
  box: { label: "Box", color: "#0061d5" },
  monday: { label: "monday.com", color: "#ff3d57" },
  mondaycom: { label: "monday.com", color: "#ff3d57" },
  grok: { label: "Grok", color: "#111111" },
};

function resolveBrand(server: string): StepBrand {
  const norm = server.toLowerCase().replace(/[_\-\s]+/g, "");
  const known = BRANDS[norm];
  const label = known?.label ?? titleCase(server);
  return { label, letter: (label[0] || "?").toUpperCase(), color: known?.color ?? "" };
}

/** Parse a namespaced MCP tool id `mcp__<server>__<tool>` into its parts. */
function parseMcp(toolName: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(toolName);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

/**
 * Map a tool call to a human-readable step — the single place that turns our
 * tool names + args into the "Created logo.svg" / "Ran command" lines a
 * non-technical user understands. Shared by the chat transcript and the
 * progress panel so they never describe the same action differently.
 */
export function describeStep(t: StepTranslator, toolName: string, input?: unknown): StepDescriptor {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // While a tool call is still streaming its name isn't known yet (the caller
  // hands us the "unknown" sentinel). Show a neutral "working" line, never a
  // literal "Unknown…" — the real label snaps in once the name arrives.
  if (!toolName || toolName.toLowerCase() === "unknown") {
    return { Icon: Wrench, label: t("usedTool"), activeLabel: t("working"), category: "other" };
  }

  // Connected apps (MCP) — their own category, shown by brand not by wrench.
  const mcp = parseMcp(toolName);
  if (mcp) {
    const brand = resolveBrand(mcp.server);
    const action = prettyToolName(mcp.tool);
    return {
      Icon: Plug,
      label: `${brand.label} · ${action}`,
      activeLabel: `${brand.label}…`,
      category: "mcp",
      brand,
    };
  }

  const name = toolName.toLowerCase();

  // Skills — load a special ability; shown by its human name.
  if (name === "skill") {
    const skill = typeof args.name === "string" ? args.name : "";
    return {
      Icon: Sparkles,
      label: skill ? t("usedSkill", { name: skill }) : t("usedSkillGeneric"),
      activeLabel: skill ? t("usingSkill", { name: skill }) : t("usingSkillGeneric"),
      category: "skill",
    };
  }

  switch (name) {
    case "write_file": {
      const file = basename(args.path);
      return { Icon: FilePlus, label: t("createdFile", { file }), activeLabel: t("creatingFile", { file }), category: "file" };
    }
    case "str_replace": {
      const file = basename(args.path);
      return { Icon: FilePen, label: t("editedFile", { file }), activeLabel: t("editingFile", { file }), category: "file" };
    }
    case "read_file": {
      const file = basename(args.path);
      return { Icon: FileText, label: t("readFile", { file }), activeLabel: t("readingFile", { file }), category: "file" };
    }
    case "list_files":
      return { Icon: Folder, label: t("listedFiles"), activeLabel: t("listingFiles"), category: "file" };
    case "search_files": {
      const query = clip(args.pattern, 32);
      return {
        Icon: Search,
        label: query ? t("searchedFor", { query }) : t("searchedFiles"),
        activeLabel: t("searchingFiles"),
        category: "search",
      };
    }
    case "execute_bash":
      return { Icon: Terminal, label: t("ranCommand"), activeLabel: t("runningCommand"), detail: clip(args.command), category: "exec" };
    case "execute_python":
      return { Icon: Code, label: t("ranPython"), activeLabel: t("runningPython"), category: "exec" };
    case "execute_node":
      return { Icon: Code, label: t("ranJavaScript"), activeLabel: t("runningJavaScript"), category: "exec" };
  }

  // Heuristics for MCP / unknown tools so they still read like actions.
  if (/(web|search|google|brave|tavily)/.test(name)) {
    const query = clip(args.query ?? args.q ?? args.pattern, 40);
    return { Icon: Globe, label: query ? t("searchedWebFor", { query }) : t("searchedWeb"), activeLabel: t("searchingWeb"), category: "search" };
  }
  if (/(fetch|http|url|browse|scrape)/.test(name)) {
    return { Icon: Globe, label: t("fetchedPage"), activeLabel: t("fetchingPage"), category: "browse" };
  }

  // Unknown tool — its own name is the most useful label (not translatable).
  const pretty = prettyToolName(toolName);
  return { Icon: Wrench, label: pretty || t("usedTool"), activeLabel: pretty ? `${pretty}…` : t("working"), category: "other" };
}
