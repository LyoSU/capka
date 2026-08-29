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
  /** The WHOLE path, when the step acted on one concrete file — `detail` carries
   *  only its basename, which is what a person should read, but a file viewer
   *  needs the path to actually open it. Absent for directories and for args
   *  that are still streaming: half a path resolves to the wrong file. */
  file?: string;
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

/** snake_case / kebab → "Title Case" words. Named for the SLUG it takes:
 *  `models/normalize.ts` exports a different `titleCase` that splits on
 *  whitespace only and leaves already-capitalised words ("GPT", "AI") alone, so
 *  one bare name for two behaviours was an invitation to grab the wrong one. */
function titleCaseSlug(name: string): string {
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
  const label = known?.label ?? titleCaseSlug(server);
  return { label, letter: (label[0] || "?").toUpperCase(), color: known?.color ?? "" };
}

/**
 * Drop a leading copy of the connector's own name from its tool id.
 *
 * MCP servers very commonly prefix every tool with the server name
 * (`Silpo_get_my_shopping_cart`, `GoogleDrive_list_files`), and our branded prefix
 * then says it a second time: "Silpo · Silpo get my shopping cart". That's not one
 * connector's quirk — it's the convention, so it has to be handled here rather than
 * per-brand.
 *
 * Matched on a normalized form (case and separators dropped) so `GoogleDrive_…`,
 * `google_drive_…` and `gdrive_…` all match the "Google Drive" label. Compared
 * word by word, longest prefix first, and never allowed to consume the whole name —
 * a tool that merely *starts* with the same letters keeps its own words, and a tool
 * called exactly `Silpo` still has something left to show.
 */
function stripConnectorPrefix(tool: string, brandLabel: string, server: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = [brandLabel, server].map(norm).filter(Boolean);
  const parts = tool.split(/[_\-\s]+/).filter(Boolean);
  for (let take = parts.length - 1; take >= 1; take--) {
    if (candidates.includes(norm(parts.slice(0, take).join("")))) {
      return parts.slice(take).join(" ");
    }
  }
  return parts.join(" ");
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
    const action = prettyToolName(stripConnectorPrefix(mcp.tool, brand.label, mcp.server));
    // When the tool's whole name IS the connector's name, there is no action left to
    // add — "Silpo · Silpo" would be the brand twice with a separator between.
    const same = action.toLowerCase().replace(/[^a-z0-9]/g, "") === brand.label.toLowerCase().replace(/[^a-z0-9]/g, "");
    return {
      iconKey: "plug",
      label: same || !action ? brand.label : `${brand.label} · ${action}`,
      activeLabel: `${brand.label}…`,
      category: "mcp",
      brand,
    };
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
    return {
      iconKey: "sparkles",
      label: t("usedSkillGeneric"),
      activeLabel: t("usingSkillGeneric"),
      // A skill id is a slug ("seo-audit"), so it reads as a token, not prose.
      detail: (typeof args.name === "string" ? args.name : "") || undefined,
      category: "skill",
    };
  }

  switch (name) {
    case "write_file":
      return {
        iconKey: "file-plus",
        label: t("createdFileGeneric"),
        activeLabel: t("creatingFileGeneric"),
        detail: basename(args.path) || undefined,
        file: typeof args.path === "string" && args.path.trim() ? args.path : undefined,
        category: "file",
      };
    case "str_replace":
      return {
        iconKey: "file-pen",
        label: t("editedFileGeneric"),
        activeLabel: t("editingFileGeneric"),
        detail: basename(args.path) || undefined,
        file: typeof args.path === "string" && args.path.trim() ? args.path : undefined,
        category: "file",
      };
    case "read_file":
      return {
        iconKey: "file-text",
        label: t("readFileGeneric"),
        activeLabel: t("readingFileGeneric"),
        detail: basename(args.path) || undefined,
        file: typeof args.path === "string" && args.path.trim() ? args.path : undefined,
        category: "file",
      };
    case "list_files":
      return { iconKey: "folder", label: t("listedFiles"), activeLabel: t("listingFiles"), category: "file" };
    case "search_files":
      // A glob/regex is a machine token like a path, so it goes in the well too.
      // The web *query* below deliberately does not — see the comment there.
      return {
        iconKey: "search",
        label: t("searchedFiles"),
        activeLabel: t("searchingFiles"),
        detail: clip(args.pattern, 32) || undefined,
        category: "search",
      };
    case "view_file":
      return {
        iconKey: "file-text",
        label: t("viewedFileGeneric"),
        activeLabel: t("viewingFileGeneric"),
        detail: basename(args.path) || undefined,
        file: typeof args.path === "string" && args.path.trim() ? args.path : undefined,
        category: "file",
      };
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

  // The one object that stays INSIDE the sentence. Every other step puts the
  // thing it acted on in `detail`, which the web renders as a sunken mono well —
  // right for a path, a glob or a slug, wrong for a web query, because a query is
  // prose the user typed. "petrol prices near me" set in monospace reads as broken
  // typography, and the well's "machine detail, skippable" framing is a lie for
  // the one field that says what the user actually wanted to know.
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

/**
 * What the model actually SENT — the "Invocation" block shown above a step's
 * result.
 *
 * Deliberately separate from `describeStep`, which answers "what did it do" as a
 * sentence in the user's language. This answers "with what", verbatim and
 * unlocalized. Merging them would force one of the two to compromise: a
 * forty-line Python program is not prose, and a prose sentence is not something
 * you can copy and re-run.
 *
 * Returns `null` — never an empty block — for three different reasons that all
 * look the same from the caller's side, and should:
 *  - the tool's only argument is already the row's chip (a path, a glob);
 *  - the arguments are internal plumbing nobody outside the app can act on;
 *  - the arguments have not arrived yet. Tool args stream in character by
 *    character, so EVERY call is briefly `{}`. An empty code block rendered in
 *    that window would flash an empty frame into the timeline on every step.
 */
/** What to CALL the block, as a message key. Decided here rather than in the
 *  component: the alternative is the UI re-deriving it by sniffing the language
 *  string, which is the same brittle `name.includes(...)` guessing this module
 *  exists to replace. Named for what the user sees, not for the tool — a person
 *  reading their own chat recognises "Command" and "Changes"; "execute_bash" and
 *  "str_replace" are our vocabulary, not theirs. */
export type StepInvocationTitle = "command" | "code" | "content" | "changes" | "params";

/** One argument of a generic call, shaped for reading. Built from TYPE alone —
 *  nothing here knows which tool the argument belongs to, so a new connector
 *  needs no code (and no dictionary entry) to render decently. */
export interface StepField {
  /** The argument's name turned into words: "num_results" → "num results". */
  label: string;
  value: string;
  /** Machine-shaped (a nested structure) — keeps monospace; scalars read as prose. */
  mono: boolean;
  /** `value` is a stated prefix of something longer; the whole text lives in the
   *  sibling `json`, so the cut is one click away rather than silent. */
  clipped?: boolean;
  /** The value is a bare http(s) URL — the UI may render it as a link. */
  url?: boolean;
}

export type StepInvocation =
  | { kind: "code"; lang: string; text: string; titleKey: StepInvocationTitle }
  | { kind: "diff"; lang: string; before: string; after: string; titleKey: "changes" }
  | { kind: "fields"; entries: StepField[]; json: string; titleKey: "params" };

/** Extension → highlighter grammar. An unknown extension yields "" (plain, no
 *  highlighting) rather than a guess: colouring text by the WRONG grammar is
 *  actively misleading, where plain text is merely plain. */
const LANGS: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  mjs: "javascript", cjs: "javascript", json: "json", md: "markdown",
  css: "css", scss: "scss", html: "html", xml: "xml", svg: "xml",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", yml: "yaml", yaml: "yaml",
  toml: "toml", rs: "rust", go: "go", java: "java", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cs: "csharp", swift: "swift", kt: "kotlin",
};

function langOf(path: unknown): string {
  const s = typeof path === "string" ? path : "";
  const dot = s.lastIndexOf(".");
  return dot < 0 ? "" : LANGS[s.slice(dot + 1).toLowerCase()] ?? "";
}

/** Tools whose whole argument is already the row's chip, or is internal. Listed
 *  by name rather than inferred, so a new tool defaults to SHOWING its arguments
 *  — an unexplained action is the worse failure. */
const NO_INVOCATION = new Set([
  "read_file", "view_file", "list_files", "search_files", "manage", "skill", "check_job",
]);

export function describeInvocation(toolName: string, input?: unknown): StepInvocation | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // "" means "still streaming" for a command or a body of code — neither is a
  // meaningful empty value. `content`/`new_str` are the exceptions and check for
  // the key's ARRIVAL instead (see below).
  const filled = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const name = (toolName || "").toLowerCase();

  if (NO_INVOCATION.has(name)) return null;

  switch (name) {
    case "execute_bash": {
      const c = filled(args.command);
      return c ? { kind: "code", lang: "bash", text: c, titleKey: "command" } : null;
    }
    case "execute_python": {
      const c = filled(args.code);
      return c ? { kind: "code", lang: "python", text: c, titleKey: "code" } : null;
    }
    case "execute_node": {
      const c = filled(args.code);
      return c ? { kind: "code", lang: "javascript", text: c, titleKey: "code" } : null;
    }
    case "write_file":
      // Creating an empty file is a real action with a real result, so "" here is
      // a VALUE, not an absence — hence the arrival check. Same below for a
      // replacement that deletes text (`new_str: ""`).
      return typeof args.content === "string"
        ? { kind: "code", lang: langOf(args.path), text: args.content, titleKey: "content" }
        : null;
    case "str_replace":
      return typeof args.old_str === "string" && typeof args.new_str === "string"
        ? { kind: "diff", lang: langOf(args.path), before: args.old_str, after: args.new_str, titleKey: "changes" }
        : null;
  }

  // Everything else — MCP connectors, plugin tools, anything new. Their argument
  // names are unknowable here, so no per-tool rendering is possible — instead
  // each argument becomes a readable label/value FIELD (typed formatting only),
  // with the verbatim JSON kept alongside for the "technical details" fold.
  // Both share one deliberate ordering: CHEAPEST FIELD FIRST.
  //
  // The display clamps long text by taking a prefix, and on any call big enough
  // to be clamped the long field is the payload. Serialized in argument order,
  // `{content: <2 MB>, path: "/srv/report.csv"}` renders two megabytes of body
  // and never reaches the path — a block that shows the reader everything except
  // the one token identifying what was acted on. Sorting by serialized size
  // inverts that: identifiers are short and bodies are long, so the fields that
  // say WHAT this call was about are the ones that survive the cut.
  //
  // Applied unconditionally rather than only when over budget: it is a better
  // reading order regardless (a path above a forty-line body), and one behaviour
  // is worth more than a second code path that only runs on large inputs — which
  // is exactly the case nobody exercises by hand. Reorders only; drops nothing.
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  const cost = (v: unknown) => {
    try {
      return JSON.stringify(v)?.length ?? 0;
    } catch {
      return 0; // circular or unserializable — sorts first, and stringify below drops it
    }
  };
  entries.sort((x, y) => cost(x[1]) - cost(y[1]));
  return {
    kind: "fields",
    entries: entries.map(([k, v]) => fieldOf(k, v)),
    json: JSON.stringify(Object.fromEntries(entries), null, 2),
    titleKey: "params",
  };
}

/** A single argument value larger than this is a payload, not a parameter. The
 *  field shows its head and SAYS so (`clipped`); the whole value stays available
 *  in the invocation's raw JSON. */
const FIELD_VALUE_LIMIT = 500;

/** "num_results" / "numResults" / "num-results" → "num results". Generic by
 *  construction: argument names are the tool author's vocabulary, and any
 *  per-tool dictionary here would defeat the point of the fields view — that an
 *  unknown tool renders decently with no code written for it. */
export const humanizeKey = (k: string) =>
  k.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim() || k;

/** A whole value that is one http(s) URL — the only string shape the UI turns
 *  into a link. Deliberately strict (nothing before, no spaces after): linking
 *  prose that merely CONTAINS a URL would mean parsing prose. */
export const isBareUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

const isScalar = (v: unknown) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function fieldOf(key: string, v: unknown): StepField {
  let value: string;
  let mono = false;
  if (v == null || v === "") {
    value = "—"; // null/absent and "" carry the same information for a reader: nothing
  } else if (typeof v === "string") {
    value = v;
  } else if (typeof v === "number" || typeof v === "boolean") {
    value = String(v);
  } else if (Array.isArray(v) && v.every(isScalar)) {
    value = v.map((x) => (x == null ? "—" : String(x))).join(", ");
  } else {
    try {
      value = JSON.stringify(v) ?? "—";
    } catch {
      value = "—"; // circular/unserializable — same placeholder, the JSON fold drops it too
    }
    mono = true;
  }
  const clipped = value.length > FIELD_VALUE_LIMIT;
  if (clipped) value = value.slice(0, FIELD_VALUE_LIMIT);
  return {
    label: humanizeKey(key),
    value,
    mono,
    ...(clipped ? { clipped: true } : {}),
    // A clipped URL is a broken link, so the flag only survives an intact value.
    ...(!clipped && !mono && isBareUrl(value) ? { url: true } : {}),
  };
}
