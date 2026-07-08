/**
 * Turns a tool call + args into the human-readable step text shown to users
 * ("Created logo.svg", "Running a command…"). This is the pure, framework-free
 * core so BOTH the web transcript and the server (Telegram delivery, which has
 * no React) can describe an action identically. The web wraps this to add a
 * lucide icon per `iconKey`; nothing here imports React or lucide, so pulling it
 * into the worker/instrumentation graph stays cheap and safe.
 */

/** A minimal translator shape (next-intl's `useTranslations("steps")`). */
export type StepTranslator = (key: string, values?: Record<string, string | number>) => string;

/** What kind of action a step is, so the UI can group/colour by *intent*. */
export type StepCategory = "file" | "exec" | "search" | "browse" | "mcp" | "skill" | "other";

/** Symbolic icon name; the web maps it to a concrete lucide component. */
export type StepIconKey =
  | "file-plus" | "file-pen" | "file-text" | "folder" | "search"
  | "terminal" | "code" | "globe" | "wrench" | "sparkles" | "plug" | "sliders";

/** A connected app behind an MCP tool — shown by brand, not a wrench. */
export interface StepBrand {
  label: string;
  letter: string;
  color: string;
}

export interface StepInfo {
  iconKey: StepIconKey;
  /** Past-tense, with the concrete object: "Created logo.svg". */
  label: string;
  /** Present-tense for the running state: "Creating logo.svg…". */
  activeLabel: string;
  /** Optional dim trailing detail (e.g. the command that ran). */
  detail?: string;
  category: StepCategory;
  brand?: StepBrand;
}

/** Last path segment, or "" when no usable path (e.g. args still streaming). */
const basename = (p: unknown): string => {
  const s = typeof p === "string" ? p : "";
  const trimmed = s.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "";
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

/** Known MCP connectors → branded chip. Keyed by the *normalized* server token. */
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
 * non-technical user understands.
 */
export function describeStep(t: StepTranslator, toolName: string, input?: unknown): StepInfo {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (!toolName || toolName.toLowerCase() === "unknown") {
    return { iconKey: "wrench", label: t("usedTool"), activeLabel: t("working"), category: "other" };
  }

  const mcp = parseMcp(toolName);
  if (mcp) {
    const brand = resolveBrand(mcp.server);
    const action = prettyToolName(mcp.tool);
    return { iconKey: "plug", label: `${brand.label} · ${action}`, activeLabel: `${brand.label}…`, category: "mcp", brand };
  }

  const name = toolName.toLowerCase();

  if (name === "manage") {
    // The running / generic label; a finished result usually replaces this with its
    // own localized one-liner (see `manageStepLabel`), EXCEPT for internal reads
    // (list/capabilities/get) whose summary is deliberately hidden — those fall back
    // to THIS label, so it must not say "Updated settings" when nothing was updated
    // (a false alarm when the user merely asked a question). Split read vs mutate:
    //  - debug: connector-shaped diagnostic read (plug).
    //  - list/capabilities/get: settings read → "Checked settings".
    //  - everything else (set/add/remove/enable/disable/…): a real change.
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "debug") {
      return { iconKey: "plug", label: t("checkedConnector"), activeLabel: t("checkingConnector"), category: "mcp" };
    }
    const isRead = action === "list" || action === "capabilities" || action === "get";
    return {
      iconKey: "sliders",
      label: isRead ? t("checkedSettings") : t("managedSettings"),
      activeLabel: isRead ? t("checkingSettings") : t("managingSettings"),
      category: "other",
    };
  }

  if (name === "skill") {
    const skill = typeof args.name === "string" ? args.name : "";
    return {
      iconKey: "sparkles",
      label: skill ? t("usedSkill", { name: skill }) : t("usedSkillGeneric"),
      activeLabel: skill ? t("usingSkill", { name: skill }) : t("usingSkillGeneric"),
      category: "skill",
    };
  }

  switch (name) {
    case "write_file": {
      const file = basename(args.path);
      return {
        iconKey: "file-plus",
        label: file ? t("createdFile", { file }) : t("createdFileGeneric"),
        activeLabel: file ? t("creatingFile", { file }) : t("creatingFileGeneric"),
        category: "file",
      };
    }
    case "str_replace": {
      const file = basename(args.path);
      return {
        iconKey: "file-pen",
        label: file ? t("editedFile", { file }) : t("editedFileGeneric"),
        activeLabel: file ? t("editingFile", { file }) : t("editingFileGeneric"),
        category: "file",
      };
    }
    case "read_file": {
      const file = basename(args.path);
      return {
        iconKey: "file-text",
        label: file ? t("readFile", { file }) : t("readFileGeneric"),
        activeLabel: file ? t("readingFile", { file }) : t("readingFileGeneric"),
        category: "file",
      };
    }
    case "list_files":
      return { iconKey: "folder", label: t("listedFiles"), activeLabel: t("listingFiles"), category: "file" };
    case "search_files": {
      const query = clip(args.pattern, 32);
      return {
        iconKey: "search",
        label: query ? t("searchedFor", { query }) : t("searchedFiles"),
        activeLabel: t("searchingFiles"),
        category: "search",
      };
    }
    case "view_file": {
      const file = basename(args.path);
      return {
        iconKey: "file-text",
        label: file ? t("viewedFile", { file }) : t("viewedFileGeneric"),
        activeLabel: file ? t("viewingFile", { file }) : t("viewingFileGeneric"),
        category: "file",
      };
    }
    case "check_job":
      return { iconKey: "terminal", label: t("checkedJob"), activeLabel: t("checkingJob"), category: "exec" };
    case "execute_bash":
      return args.background
        ? { iconKey: "terminal", label: t("startedJob"), activeLabel: t("startingJob"), detail: clip(args.command), category: "exec" }
        : { iconKey: "terminal", label: t("ranCommand"), activeLabel: t("runningCommand"), detail: clip(args.command), category: "exec" };
    case "execute_python":
      return { iconKey: "code", label: t("ranPython"), activeLabel: t("runningPython"), category: "exec" };
    case "execute_node":
      return { iconKey: "code", label: t("ranJavaScript"), activeLabel: t("runningJavaScript"), category: "exec" };
  }

  if (/(web|search|google|brave|tavily)/.test(name)) {
    const query = clip(args.query ?? args.q ?? args.pattern, 40);
    return { iconKey: "globe", label: query ? t("searchedWebFor", { query }) : t("searchedWeb"), activeLabel: t("searchingWeb"), category: "search" };
  }
  if (/(fetch|http|url|browse|scrape)/.test(name)) {
    return { iconKey: "globe", label: t("fetchedPage"), activeLabel: t("fetchingPage"), category: "browse" };
  }

  const pretty = prettyToolName(toolName);
  return { iconKey: "wrench", label: pretty || t("usedTool"), activeLabel: pretty ? `${pretty}…` : t("working"), category: "other" };
}
